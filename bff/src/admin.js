/**
 * Admin console API.
 *
 * Small on purpose. It exists so a property can change what its televisions
 * look like without a deploy - upload a photo or a loop, pick one, done.
 *
 * Everything under /api/admin requires the console token. That is a real
 * boundary, not decoration: this service answers on a public domain, and
 * without it anyone could hang arbitrary video in front of every room in the
 * building.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { db, now } from './db.js';
import {
  getSetting,
  setSetting,
  safeMediaUrl,
  safeColor,
  safeCss,
  homeConfig,
  setScene,
  setTv,
} from './settings.js';
import * as media from './media.js';
import * as adult from './adult.js';
import * as xui from './xui.js';
import * as rooms from './rooms.js';
import * as pay from './pay.js';
import * as billing from './billing.js';
import * as svc from './service.js';
import * as props from './properties.js';
import * as panels from './panels.js';
import * as explore from './explore.js';
import * as auth from './adminauth.js';
import { PLATFORM } from './db.js';

/**
 * Resolve the console token once at boot.
 *
 * A generated token is persisted so it survives a restart - an operator who
 * wrote it down does not want a new one every deploy.
 */
export function resolveToken(log) {
  if (config.admin.token) return config.admin.token;

  let token = getSetting(PLATFORM, 'admin.token');
  if (!token) {
    token = randomBytes(9).toString('base64url');
    setSetting(PLATFORM, 'admin.token', token);
    log.warn(
      { token },
      'ADMIN_TOKEN is not set; generated one for the admin console. Set ADMIN_TOKEN to choose your own.',
    );
  } else {
    log.info({ token }, 'admin console token (from database; set ADMIN_TOKEN to override)');
  }
  return token;
}

/** Constant-time compare that does not leak the token's length through timing. */
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still burn a comparison so a wrong length is not measurably faster.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

const NAMES = {
  propertyName: 'home.propertyName',
  supportContact: 'home.supportContact',
  welcomeText: 'home.welcomeText',
};

export function registerAdmin(app) {
  const token = resolveToken(app.log);

  /**
   * What the console token protects.
   *
   * Not just /api/admin. Device pairing and the device list are operator
   * tools that happen to live under /api/device, and they were left open:
   * `bind` let anyone point any box at any line, and `list` answered a plain
   * GET with every device's row - line credentials, pairing codes, MACs and
   * room numbers - on a public domain. Neither is called by the television app
   * or the console, so closing them breaks nothing and shuts a real door.
   */
  const guarded = (url) =>
    url.startsWith('/api/admin/') ||
    url.startsWith('/api/device/bind') ||
    url.startsWith('/api/device/list');

  /**
   * 谁在敲门。
   *
   * 两种身份，一个入口：
   *
   *   **平台**（ADMIN_TOKEN）—— 十家都看得见，能建店、删店、划盒子、
   *   改我们自己的收款商户。这个口令从来不发给酒店。
   *   **某一家酒店**（properties.token_hash）—— 只看得见自己这一家。
   *   它的 `req.property` 一路带到每个查询里，不是靠界面藏，是靠 SQL 的
   *   WHERE 条件挡 —— 前者随便按个 F12 就绕过去了。
   *
   * `req.pid` 是给下面每个路由用的：平台是 null（不限制），酒店是它自己的 id。
   */
  app.addHook('onRequest', async (req, reply) => {
    if (!guarded(req.url)) return;
    if (req.url === '/api/admin/login') return;

    const header = req.headers['authorization'] ?? '';
    const bearer = /^Bearer\s+(.+)$/i.exec(String(header))?.[1];
    const given = bearer ?? req.headers['x-admin-token'];

    /*
     * 三种凭据，一个入口，**按从窄到宽的顺序认**：
     *
     *   会话票    控制台登录之后拿到的，背后是某一个账号（知道是谁）
     *   平台口令  .env 里的 ADMIN_TOKEN，保底钥匙（不知道是谁）
     *   酒店口令  某一家自己的口令（知道是哪家，不知道是谁）
     *
     * 后两种留着不是偷懒：一个还没建过账号的部署，砍掉它们就当场把自己
     * 锁在门外。账号建起来之后，它们应该收进保险箱而不是发给前台。
     */
    const sess = auth.resolveSession(given);
    if (sess) {
      req.who = sess;
      req.isPlatform = sess.role === 'platform';
      req.property = sess.propertyId ? props.find(sess.propertyId) : null;
      req.pid = req.isPlatform ? null : sess.propertyId;
    } else if (tokenMatches(given, token)) {
      req.who = { userId: null, username: null, role: 'platform', propertyId: null };
      req.isPlatform = true;
      req.property = null;
      req.pid = null;
    } else {
      const p = props.authenticate(given);
      if (!p) return reply.code(401).send({ error: '未授权' });
      req.who = { userId: null, username: null, role: 'manager', propertyId: p.id };
      req.isPlatform = false;
      req.property = p;
      req.pid = p.id;
    }

    /*
     * 角色拦在这里，不是拦在界面上。
     *
     * 前台的按钮藏不藏是体验问题；**他直接 curl 打这条接口能不能成，
     * 才是权限问题**。所以这一关在所有路由之前，按方法 + 路径的白名单过。
     */
    if (!auth.allowed(req.who.role, req.method, req.url)) {
      return reply.code(403).send({ error: '你的账号没有这一项的权限' });
    }
  });

  /*
   * 写操作记一笔。
   *
   * 挂在 onResponse 上是因为这时候才知道成没成 —— 失败的尝试记下来只会
   * 让真正要查的那一行更难找。读操作一概不记（见 adminauth.record）。
   */
  app.addHook('onResponse', async (req, reply) => {
    if (!guarded(req.url) || !req.who) return;
    try {
      auth.record({
        who: req.who,
        method: req.method,
        url: req.url,
        body: req.body,
        propertyId: req.pid ?? viewPid(req),
        status: reply.statusCode,
      });
    } catch (err) {
      req.log.warn({ err: err.message }, '操作记录写失败');
    }
  });

  /**
   * 这次请求该「显示」哪一家。
   *
   * 跟 target() 的区别：target 是「作用在哪一家」，没指明就报错；
   * viewPid 是「列表里显示谁」，平台没指明就显示全部。改完一台盒子之后要
   * 回一份列表，用的就是这个 —— 平台选着某一家时只回那一家，免得每次操作
   * 都把十家的设备重新推一遍。
   */
  const viewPid = (req) => {
    if (!req.isPlatform) return req.pid;
    const asked = Number(req.query?.property ?? req.body?.propertyId);
    return Number.isInteger(asked) && props.find(asked) ? asked : null;
  };

  /** 只有平台能做的事。 */
  const platformOnly = (req, reply) => {
    if (req.isPlatform) return false;
    reply.code(403).send({ error: '这一项只有平台管理员能操作' });
    return true;
  };

  /**
   * 这次请求作用在哪家酒店上。
   *
   * 酒店管理员永远是自己那一家，`?property=` 传什么都没用。
   * 平台管理员要显式指定 —— 十家里改哪一家的背景，不能靠猜。
   */
  const target = (req, reply) => {
    if (!req.isPlatform) return req.pid;
    const asked = Number(req.query?.property ?? req.body?.propertyId);
    if (Number.isInteger(asked) && props.find(asked)) return asked;
    reply.code(400).send({ error: '请指明是哪家酒店（property=<id>）' });
    return undefined;
  };

  /**
   * 登录。**换回来的是一张有期限的票，不是密码本身。**
   *
   * 浏览器里存密码的问题不在于「会被偷看」，而在于出事之后没有补救手段：
   * 改 .env 重启是唯一的办法，而且会把所有人一起踢下线。票可以单独吊销。
   *
   * 两种进法：账号密码（知道是谁），或者老口令（保底）。两条路都过限速。
   */
  app.post('/api/admin/login', async (req, reply) => {
    const username = String(req.body?.username ?? '').trim().toLowerCase();
    const given = req.body?.password ?? req.body?.token;

    const ip = String(req.headers['x-forwarded-for'] ?? req.ip ?? '').split(',')[0].trim();
    const keys = ['ip:' + ip, ...(username ? ['user:' + username] : [])];

    const wait = auth.lockedFor(keys);
    if (wait > 0) {
      return reply.code(429).send({
        error: '试得太多了，请 ' + Math.ceil(wait / 1000) + ' 秒后再试',
        retryAfterMs: wait,
      });
    }

    const label = String(req.headers['user-agent'] ?? '').slice(0, 60);
    const done = (who, extra) => {
      auth.clearFail(keys);
      const session = auth.startSession(who, { label });
      return { ok: true, session, ...extra };
    };

    if (username) {
      const u = auth.authenticate(username, given);
      if (!u) {
        auth.noteFail(keys);
        return reply.code(401).send({ error: '用户名或密码不对' });
      }
      const scope = u.role === 'platform' ? 'platform' : 'property';
      return done(
        { userId: u.id, role: u.role, propertyId: u.property_id },
        {
          scope,
          role: u.role,
          username: u.username,
          properties: scope === 'platform' ? props.overview() : undefined,
          property: u.property_id ? props.publicProperty(props.find(u.property_id)) : undefined,
        },
      );
    }

    if (tokenMatches(given, token)) {
      return done(
        { userId: null, role: 'platform', propertyId: null },
        { scope: 'platform', role: 'platform', properties: props.overview() },
      );
    }

    const p = props.authenticate(given);
    if (p) {
      return done(
        { userId: null, role: 'manager', propertyId: p.id },
        { scope: 'property', role: 'manager', property: props.publicProperty(p) },
      );
    }

    auth.noteFail(keys);
    return reply.code(401).send({ error: '密码不对' });
  });

  /** 我是谁、能干什么。控制台每次打开先问这一条。 */
  app.get('/api/admin/me', async (req) => ({
    scope: req.isPlatform ? 'platform' : 'property',
    role: req.who.role,
    roleName: auth.ROLE_NAMES[req.who.role] ?? req.who.role,
    username: req.who.username,
    namedAccount: req.who.userId != null,
    property: req.property ? props.publicProperty(req.property) : null,
    properties: req.isPlatform ? props.overview() : undefined,
    anyUsers: auth.anyUsers(),
  }));

  app.post('/api/admin/logout', async (req) => {
    const header = req.headers['authorization'] ?? '';
    auth.endSession(/^Bearer\s+(.+)$/i.exec(String(header))?.[1]);
    return { ok: true };
  });

  // --------------------------------------------------------------- 账号

  /*
   * 谁能管谁：平台管全部，酒店管理员只管自己这一家、而且**建不出平台账号**。
   * 前台一条都进不来（白名单里没有 /users）。
   */
  const manageable = (req, reply, targetPid) => {
    if (req.isPlatform) return true;
    if (req.who.role !== 'manager') {
      reply.code(403).send({ error: '你的账号没有这一项的权限' });
      return false;
    }
    if (targetPid != null && Number(targetPid) !== req.pid) {
      reply.code(403).send({ error: '只能管自己这一家的账号' });
      return false;
    }
    return true;
  };

  app.get('/api/admin/users', async (req, reply) => {
    if (!manageable(req, reply, null)) return;
    return { users: auth.listUsers(req.isPlatform ? viewPid(req) : req.pid), roles: auth.ROLE_NAMES };
  });

  app.post('/api/admin/users', async (req, reply) => {
    const pid = req.isPlatform ? (req.body?.role === 'platform' ? null : viewPid(req)) : req.pid;
    if (!manageable(req, reply, pid)) return;
    if (!req.isPlatform && req.body?.role === 'platform') {
      return reply.code(403).send({ error: '酒店管理员建不了平台账号' });
    }
    if (req.isPlatform && req.body?.role !== 'platform' && pid == null) {
      return reply.code(400).send({ error: '请先在上面选一家酒店' });
    }
    try {
      const user = auth.createUser({
        username: req.body?.username,
        password: req.body?.password,
        role: req.body?.role,
        propertyId: pid,
      });
      return { ok: true, user, users: auth.listUsers(req.isPlatform ? viewPid(req) : req.pid) };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  app.post('/api/admin/users/:id', async (req, reply) => {
    const u = auth.findUser(req.params.id);
    if (!u) return reply.code(404).send({ error: '账号不存在' });
    if (!manageable(req, reply, u.property_id)) return;
    try {
      if (req.body?.password !== undefined) auth.setPassword(u.id, req.body.password);
      if (req.body?.active !== undefined) auth.setActive(u.id, req.body.active);
      if (req.body?.logoutEverywhere) auth.endAllSessions(u.id);
      return { ok: true, users: auth.listUsers(req.isPlatform ? viewPid(req) : req.pid) };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    const u = auth.findUser(req.params.id);
    if (!u) return reply.code(404).send({ error: '账号不存在' });
    if (!manageable(req, reply, u.property_id)) return;
    // 删自己会把自己锁在外面，而且多半是点错了。
    if (req.who.userId === u.id) return reply.code(400).send({ error: '不能删自己' });
    auth.removeUser(u.id);
    return { ok: true, users: auth.listUsers(req.isPlatform ? viewPid(req) : req.pid) };
  });

  /** 操作记录。酒店只看得见自己这一家的。 */
  app.get('/api/admin/audit', async (req, reply) => {
    if (!manageable(req, reply, null)) return;
    return { rows: auth.auditList(req.isPlatform ? viewPid(req) : req.pid, req.query?.limit) };
  });

  // --------------------------------------------------------- 旅游周边

  /*
   * 一家酒店只看得见自己的周边条目。和菜单一样，靠的是每条查询里的
   * property_id，不是界面上藏几个按钮。
   */
  app.get('/api/admin/explore', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    return { spots: explore.all(pid), languages: explore.languages };
  });

  app.post('/api/admin/explore', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    try {
      explore.save(pid, req.body ?? {});
      return { ok: true, spots: explore.all(pid) };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  app.delete('/api/admin/explore/:id', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    if (!explore.remove(pid, req.params.id)) {
      return reply.code(404).send({ error: '这一条不存在' });
    }
    return { ok: true, spots: explore.all(pid) };
  });

  // ------------------------------------------------------------- 面板

  /*
   * 接了哪几台 XUI / Xtream 面板。只有平台管得 ——
   * 哪家酒店从哪台机器拿片，是发货层面的事。
   */
  app.get('/api/admin/panels', async (req, reply) => {
    if (platformOnly(req, reply)) return;
    return { panels: panels.overview() };
  });

  app.post('/api/admin/panels', async (req, reply) => {
    if (platformOnly(req, reply)) return;
    try {
      panels.create(req.body ?? {});
      return { ok: true, panels: panels.overview() };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  app.post('/api/admin/panels/:id', async (req, reply) => {
    if (platformOnly(req, reply)) return;
    try {
      if (!panels.update(Number(req.params.id), req.body ?? {})) {
        return reply.code(404).send({ error: '面板不存在' });
      }
      return { ok: true, panels: panels.overview() };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  app.delete('/api/admin/panels/:id', async (req, reply) => {
    if (platformOnly(req, reply)) return;
    const r = panels.remove(Number(req.params.id));
    if (!r.ok) return reply.code(409).send({ error: r.error });
    return { ok: true, panels: panels.overview() };
  });

  /**
   * 拿一条线路去试这台面板，把它真能看到什么报回来。
   *
   * 存在的理由：面板和线路填错了，现象是酒店的电视全黑，而不是后台报错 ——
   * 所以得有一个地方能在指过去之前先问一句「这对账号在这台机器上算数吗」。
   */
  app.post('/api/admin/panels/:id/test', async (req, reply) => {
    if (platformOnly(req, reply)) return;
    const panel = panels.find(Number(req.params.id));
    if (!panel) return reply.code(404).send({ error: '面板不存在' });

    const username = String(req.body?.lineUser ?? '').trim();
    const password = String(req.body?.linePass ?? '').trim();
    if (!username || !password) {
      return reply.code(400).send({ error: '要同时给线路账号和密码' });
    }

    const line = {
      username,
      password,
      api: panel.api_base,
      pub: panel.public_base,
      // 试的当下不进缓存：上一秒的结果回答不了「现在通不通」。
      panelId: `test-${panel.id}-${Date.now()}`,
    };

    try {
      const info = await xui.authenticate(line);
      const status = info?.user_info?.auth === 1 || info?.user_info?.status === 'Active';
      if (!status) {
        return {
          ok: false,
          reason: '面板连上了，但这条线路在它上面不算数',
          status: info?.user_info?.status ?? null,
        };
      }
      /*
       * 拿不到就是 null，不是 0。
       *
       * 片库大的面板，一份电影列表好几 MB，15 秒内拿不完很正常。
       * 把超时显示成「0 部电影」会让人以为面板是空的，而它实际上有五千多部。
       */
      const n = (v) => (Array.isArray(v) ? v.length : null);
      const [live, movies, series] = await Promise.all([
        xui.liveStreams(line).catch(() => null),
        xui.vodStreams(line).catch(() => null),
        xui.seriesList(line).catch(() => null),
      ]);
      return {
        ok: true,
        status: info?.user_info?.status ?? null,
        // 并发上限是最容易踩的坑：填了一条 max_connections=1 的线路，
        // 第一个房间能看、第二个就打不开，看起来像系统坏了。
        maxConnections: Number(info?.user_info?.max_connections ?? 0) || null,
        expiresAt: info?.user_info?.exp_date ? Number(info.user_info.exp_date) : null,
        live: n(live),
        movies: n(movies),
        series: n(series),
      };
    } catch (err) {
      /*
       * 面板对一条不存在的线路回的是 404，不是一句「密码错了」。
       * 原样报「XUI 404 on auth」没人看得懂，而这正好是最常见的一种失败。
       */
      const msg = String(err.message ?? '');
      const denied = ['401', '403', '404'].some((c) => msg.includes(c));
      /* 连不上和认不过是两种毛病，该去查的地方也不同：前者查地址和防火墙，
         后者查线路账号。原样甩一句 `fetch failed` 两边都不像。 */
      const offline = msg.includes('fetch failed') || err.name === 'TimeoutError';
      return {
        ok: false,
        reason: denied
          ? '面板连上了，但这对账号密码在它上面不存在'
          : offline
            ? '连不上这台面板 —— 接口地址填错了，或者它没开、被防火墙挡着'
            : msg,
      };
    }
  });

  // ------------------------------------------------------------- 酒店

  /** 十家的概览。酒店管理员只会看到自己那一家。 */
  app.get('/api/admin/properties', async (req) => ({
    scope: req.isPlatform ? 'platform' : 'property',
    properties: req.isPlatform
      ? props.overview()
      : props.overview().filter((p) => p.id === req.pid),
    defaultProperty: req.isPlatform
      ? Number(getSetting(PLATFORM, 'devices.defaultProperty') ?? 0) || null
      : undefined,
  }));

  app.post('/api/admin/properties', async (req, reply) => {
    if (platformOnly(req, reply)) return;
    try {
      const p = props.create(req.body ?? {});
      return { ok: true, property: props.publicProperty(p), properties: props.overview() };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  app.post('/api/admin/properties/:id', async (req, reply) => {
    // 酒店能改自己的名字和联系方式；换线路、停用、改归属是平台的事。
    const id = Number(req.params.id);
    if (!req.isPlatform && id !== req.pid) return reply.code(403).send({ error: '只能改自己这一家' });

    const body = { ...(req.body ?? {}) };
    if (!req.isPlatform) {
      delete body.lineUser;
      delete body.linePass;
      delete body.active;
      // 换面板是发货层面的事，而且别家的面板酒店压根不该知道存在。
      delete body.panelId;
    }
    try {
      const p = props.save(id, body);
      if (!p) return reply.code(404).send({ error: '酒店不存在' });
      return { ok: true, property: props.publicProperty(p), properties: props.overview() };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  /** 给某一家设后台口令。平台设初始口令，酒店自己可以改自己的。 */
  app.post('/api/admin/properties/:id/token', async (req, reply) => {
    const id = Number(req.params.id);
    if (!req.isPlatform && id !== req.pid) return reply.code(403).send({ error: '只能改自己这一家' });
    try {
      const p = props.setToken(id, req.body?.token);
      if (!p) return reply.code(404).send({ error: '酒店不存在' });
      return { ok: true, property: props.publicProperty(p) };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  app.delete('/api/admin/properties/:id', async (req, reply) => {
    if (platformOnly(req, reply)) return;
    if (!props.remove(req.params.id)) return reply.code(404).send({ error: '酒店不存在' });
    return { ok: true, properties: props.overview() };
  });

  /**
   * 新盒子默认进哪一家。
   *
   * 一次铺一家的时候设上，整批盒子插电即用。铺完清掉 —— 留着的话，
   * 下一家的盒子会自动进错门。
   */
  app.post('/api/admin/properties/default', async (req, reply) => {
    if (platformOnly(req, reply)) return;
    const id = req.body?.propertyId == null ? null : Number(req.body.propertyId);
    if (id != null && !props.find(id)) return reply.code(404).send({ error: '酒店不存在' });
    setSetting(PLATFORM, 'devices.defaultProperty', id == null ? null : String(id));
    return { ok: true, defaultProperty: id };
  });

  app.get('/api/admin/state', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    return {
      propertyId: pid,
      property: props.publicProperty(props.find(pid)),
      home: homeConfig(pid),
      media: media.list(pid),
      maxUploadBytes: config.admin.maxUploadBytes,
      envBackgroundUrl: config.home.backgroundUrl || null,
      stats: {
        devices: db.prepare('SELECT COUNT(*) n FROM devices WHERE property_id = ?').get(pid).n,
        rooms: db.prepare('SELECT COUNT(*) n FROM rooms WHERE property_id = ?').get(pid).n,
      },
      adult: adultState(pid),
    };
  });

  /**
   * The restricted section, as the console needs to see it.
   *
   * The PIN itself is never returned - only whether one exists. There is no
   * "show current PIN" for the same reason there is no "show current
   * password": the console is reachable from the internet, and a value that is
   * never sent cannot be read off a screen someone left open.
   */
  function adultState(pid) {
    let categories = [];
    try {
      const raw = JSON.parse(getSetting(pid, 'adult.categories') || '[]');
      if (Array.isArray(raw)) categories = raw.map(String);
    } catch {
      /* a malformed row simply means no extra patterns */
    }
    return {
      enabled: adult.adultEnabled(pid),
      pinSet: adult.pinIsSet(pid),
      categories,
      picked: adult.pickedCategories(pid),
      rooms: db
        .prepare('SELECT device_id, room_id, label, adult_allowed FROM devices WHERE property_id = ? ORDER BY room_id, created_at')
        .all(pid)
        .map((d) => ({
          deviceId: d.device_id,
          roomId: d.room_id,
          label: d.label,
          allowed: Boolean(d.adult_allowed),
        })),
    };
  }

  /**
   * Property-wide settings for the section.
   *
   * Turning it off is a master switch, not a cosmetic one: with `enabled`
   * false the content routes stop filtering *and* stop guarding, because there
   * is nothing to guard - the categories go back to being ordinary ones. That
   * is why disabling is only ever the right move for a property that does not
   * carry the section at all.
   */
  app.post('/api/admin/adult', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    const body = req.body ?? {};

    if ('pin' in body) {
      const pin = String(body.pin ?? '').trim();
      if (!pin) adult.clearPin(pid);
      else if (!/^\d{4,8}$/.test(pin)) {
        return reply.code(400).send({ error: 'PIN 必须是 4-8 位数字' });
      } else adult.setPin(pin);
    }

    if ('categoryIds' in body) {
      adult.setPickedCategories(body.categoryIds);
    }

    if ('categories' in body) {
      const list = Array.isArray(body.categories) ? body.categories : [];
      const clean = list.map((s) => String(s).trim()).filter(Boolean).slice(0, 50);
      setSetting(pid, 'adult.categories', JSON.stringify(clean));
    }

    if ('enabled' in body) {
      // Refusing to arm the section without a PIN is the whole point: enabled
      // with no PIN would be a tile anyone can walk through.
      if (body.enabled && !adult.pinIsSet(pid)) {
        return reply.code(400).send({ error: '先设置 PIN,再打开成人板块' });
      }
      setSetting(pid, 'adult.enabled', body.enabled ? '1' : '0');
    }

    // What counts as restricted has just changed, so the cached answer to
    // "which stream ids are behind the PIN" is now wrong.
    adult.invalidateRestricted(pid);
    return { ok: true, adult: adultState(pid) };
  });

  /**
   * Every category the panel actually carries, so the console can tick them.
   *
   * This is what replaced guessing at names. It reads through a real line -
   * whichever bound device's, since they share one here - because categories
   * are a property of the line, not of the panel: a bouquet nobody's line
   * carries is not a thing any room could see.
   *
   * `count` is worth the three extra calls. "伦理影片 100 部" is what tells an
   * operator which of twenty-nine similar names is the one they meant, and
   * the panel's own lists are cached upstream anyway.
   */
  app.get('/api/admin/categories', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;

    // 分类来自这家酒店自己的线路 —— 两家绑不同线路时，片库本来就不一样。
    const line = props.lineFor(props.find(pid));
    const user = line.username;
    const pass = line.password;
    if (!user || !pass) {
      return reply.code(409).send({ error: '这家酒店还没有线路，先在酒店设置里绑一条' });
    }
    // 分类 id 是按面板编的，所以读分类必须走这家酒店自己那台面板 ——
    // 读错面板的话，后台勾的受限分类到电视上对不上号。
    const callLine = props.callLineFor(property);

    const arr = (v) => (Array.isArray(v) ? v : []);
    let live = [], movies = [], series = [], liveCats = [], vodCats = [], seriesCats = [];
    try {
      [liveCats, live, vodCats, movies, seriesCats, series] = await Promise.all([
        xui.liveCategories(callLine),
        xui.liveStreams(callLine),
        xui.vodCategories(callLine),
        xui.vodStreams(callLine),
        xui.seriesCategories(callLine),
        xui.seriesList(callLine),
      ]);
    } catch (err) {
      req.log.warn({ err: err.message }, 'admin: panel categories unreachable');
      return reply.code(502).send({ error: '取不到面板分类，稍后再试' });
    }

    const tally = (items) => {
      const m = new Map();
      for (const it of arr(items)) {
        const k = String(it.category_id ?? '');
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return m;
    };
    const build = (cats, items, kind) => {
      const counts = tally(items);
      return arr(cats).map((c) => ({
        key: `${kind}:${c.category_id}`,
        id: String(c.category_id),
        name: c.category_name,
        count: counts.get(String(c.category_id)) ?? 0,
        // Shown as a hint, not as a tick: a keyword match is the safety net
        // catching something nobody has looked at yet.
        keyword: adult.isAdultCategory(pid, c.category_name),
      }));
    };

    return {
      live: build(liveCats, live, 'live'),
      vod: build(vodCats, movies, 'vod'),
      series: build(seriesCats, series, 'series'),
      picked: adult.pickedCategories(pid),
    };
  });

  /** Which rooms may see it. Off is the default and stays the default. */
  app.post('/api/admin/adult/device', async (req, reply) => {
    const { deviceId, allowed } = req.body ?? {};
    if (!deviceId) return reply.code(400).send({ error: 'deviceId required' });
    const pid = target(req, reply);
    if (pid === undefined) return;
    // 带上酒店：别家的盒子授权不了，哪怕知道它的 id。
    const exists = db
      .prepare('SELECT 1 FROM devices WHERE device_id = ? AND property_id = ?')
      .get(String(deviceId), pid);
    if (!exists) return reply.code(404).send({ error: '设备不存在' });
    adult.setDeviceAllowed(deviceId, Boolean(allowed));
    return { ok: true, adult: adultState(pid) };
  });

  /** The same answer for many rooms at once. */
  app.post('/api/admin/adult/devices', async (req, reply) => {
    const { deviceIds, allowed } = req.body ?? {};
    const list = Array.isArray(deviceIds) ? deviceIds.map(String) : [];
    if (!list.length) return reply.code(400).send({ error: 'deviceIds required' });
    const pid = target(req, reply);
    if (pid === undefined) return;
    const mine = new Set(
      db.prepare('SELECT device_id FROM devices WHERE property_id = ?').all(pid).map((d) => d.device_id),
    );
    for (const id of list.slice(0, 2000)) {
      if (mine.has(id)) adult.setDeviceAllowed(id, Boolean(allowed));
    }
    return { ok: true, adult: adultState(pid) };
  });

  app.post('/api/admin/upload', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: '没有收到文件' });
    try {
      return { ok: true, file: await media.store(pid, part) };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  app.delete('/api/admin/media/:id', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;

    const url = media.remove(req.params.id, pid);
    if (!url) return reply.code(404).send({ error: '文件不存在' });

    // A deleted file must not stay selected, or every television falls back to
    // a broken image instead of the gradient.
    if (getSetting(pid, 'home.bg.url') === url) {
      setSetting(pid, 'home.bg.type', 'none');
      setSetting(pid, 'home.bg.url', null);
    }
    if (getSetting(pid, 'home.bg.poster') === url) setSetting(pid, 'home.bg.poster', null);

    return { ok: true, home: homeConfig(pid) };
  });

  /** Pick the background: an uploaded file, an external URL, or the gradient. */
  app.post('/api/admin/home/background', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    const { type, url, poster } = req.body ?? {};

    if (type === 'none') {
      setSetting(pid, 'home.bg.type', 'none');
      setSetting(pid, 'home.bg.url', null);
      setSetting(pid, 'home.bg.poster', null);
      return { ok: true, home: homeConfig(pid) };
    }

    if (type !== 'image' && type !== 'video') {
      return reply.code(400).send({ error: 'type 只能是 image / video / none' });
    }

    const safe = safeMediaUrl(url);
    if (!safe) return reply.code(400).send({ error: '地址必须是 http(s) 链接或 /media 路径' });

    // The boxes load the launcher over HTTPS. An http:// background is mixed
    // content there and simply will not appear, so say so rather than
    // accepting a setting that silently does nothing.
    if (/^http:\/\//i.test(safe)) {
      return reply.code(400).send({
        error: '外部地址必须是 https —— http 的会被电视端当成混合内容拦掉，屏幕上不会显示',
      });
    }

    setSetting(pid, 'home.bg.type', type);
    setSetting(pid, 'home.bg.url', safe);
    setSetting(pid, 'home.bg.poster', type === 'video' ? safeMediaUrl(poster) : null);
    return { ok: true, home: homeConfig(pid) };
  });

  /**
   * Branding: the images and colour a property puts its own stamp on.
   *
   * Each field is optional and only touched when present, so the console can
   * save one section without clearing the others.
   */
  /**
   * The picture behind each screen.
   *
   * Videos are refused here rather than quietly accepted: one of these sits
   * behind the screen a viewer reaches by pressing a channel, and a second
   * decoder running there is a decoder the player does not get.
   */
  app.post('/api/admin/scenes', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    const body = req.body ?? {};
    for (const field of ['live', 'vod', 'service']) {
      if (!(field in body)) continue;
      const raw = String(body[field] ?? '').trim();
      if (!raw) {
        setScene(pid, field, null);
        continue;
      }
      const safe = safeMediaUrl(raw);
      if (!safe) {
        return reply.code(400).send({ error: `${field}: 地址必须是 http(s) 链接或 /media 路径` });
      }
      if (safe.startsWith('/media/') && media.kindOf(safe) === 'video') {
        return reply.code(400).send({ error: `${field}: 只能用图片，视频会跟播放器抢解码器` });
      }
      setScene(pid, field, safe);
    }
    return { ok: true, home: homeConfig(pid) };
  });

  app.post('/api/admin/branding', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    const body = req.body ?? {};

    for (const [field, key] of Object.entries({
      splashUrl: 'brand.splash',
      loadingUrl: 'brand.loading',
      logoUrl: 'brand.logo',
    })) {
      if (!(field in body)) continue;
      const raw = String(body[field] ?? '').trim();
      if (!raw) {
        setSetting(key, null);
        continue;
      }
      const safe = safeMediaUrl(raw);
      if (!safe) return reply.code(400).send({ error: `${field}: 地址必须是 http(s) 链接或 /media 路径` });
      if (/^http:\/\//i.test(safe)) {
        return reply.code(400).send({ error: `${field}: 外部地址必须是 https，http 的会被电视端拦掉` });
      }
      // All three of these are stills. For an uploaded file we know the type,
      // so say so now rather than let someone wonder why their splash screen
      // is black. An external URL cannot be checked and is taken on trust.
      if (safe.startsWith('/media/') && media.kindOf(safe) === 'video') {
        return reply.code(400).send({ error: `${field}: 这里只能用图片，不能用视频` });
      }
      setSetting(key, safe);
    }

    if ('accent' in body) {
      const raw = String(body.accent ?? '').trim();
      if (!raw) setSetting(pid, 'brand.accent', null);
      else {
        const color = safeColor(raw);
        if (!color) return reply.code(400).send({ error: '主色必须是 #RGB 或 #RRGGBB' });
        setSetting(pid, 'brand.accent', color);
      }
    }

    if ('customCss' in body) setSetting(pid, 'brand.css', safeCss(body.customCss));

    return { ok: true, home: homeConfig(pid) };
  });

  /** 电视端行为：排查用的诊断叠层、直播模式默认值。 */
  app.post('/api/admin/tv', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    try {
      setTv(pid, req.body ?? {});
      return { ok: true, home: homeConfig(pid) };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  app.post('/api/admin/home/text', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    const body = req.body ?? {};
    for (const [field, key] of Object.entries(NAMES)) {
      if (field in body) setSetting(pid, key, String(body[field] ?? '').slice(0, 200).trim());
    }
    return { ok: true, home: homeConfig(pid) };
  });

  // ------------------------------------------------------------- the building

  /**
   * Every box and every room, in one answer.
   *
   * The console needs both together - a box is only meaningful next to the
   * room it is in, and a room is only meaningful next to the boxes that serve
   * it - and one request keeps the page from showing half a building while
   * the other half is still loading.
   */
  app.get('/api/admin/rooms', async (req, reply) => {
    // 平台管理员看的是当前选中的那一家，外加还没分给任何人的新盒子 ——
    // 「把这台划给这家」这个动作就在这张表上做。
    if (req.isPlatform) {
      const pid = target(req, reply);
      if (pid === undefined) return;
      return rooms.roster(pid, { includeUnassigned: true });
    }
    return rooms.roster(req.pid);
  });

  /**
   * Edit one box: its room, its label, the line it streams through.
   *
   * `adoptInto` 给的是平台管理员正在管的那一家。控制台每个请求都带着
   * `?property=`（见 admin-ui 的 withProperty），所以「在这家的表里给一台
   * 无主盒子填房间号」= 把它划给这家 —— 界面上没有第二个地方能做这件事。
   */
  app.post('/api/admin/devices/:deviceId', async (req, reply) => {
    try {
      /*
       * 前台能填房间号和备注，**不能换线路**。
       *
       * 这条接口是一个口子进来的：房间号、备注、线路都在同一个 body 里。
       * 白名单放行的是「填房间号」这件事，所以线路那几格在这里剥掉 ——
       * 不剥的话，一个会按 F12 的前台可以把某间房换成别的片单，
       * 或者干脆把盒子解绑。
       */
      const patch = { ...(req.body ?? {}) };
      if (req.who.role === 'desk') {
        delete patch.lineUser;
        delete patch.linePass;
        delete patch.propertyId;
      }
      const saved = rooms.saveDevice(req.pid, req.params.deviceId, patch, {
        adoptInto: viewPid(req),
      });
      if (!saved) return reply.code(404).send({ error: '设备不存在' });
      return {
        ok: true,
        adoptedInto: saved.adoptedInto,
        moved: saved.moved,
        ...rooms.roster(viewPid(req), { includeUnassigned: req.isPlatform }),
      };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  /**
   * Forget a box.
   *
   * Only useful for a television that is gone. One still on a wall simply
   * re-registers on its next boot, which is why the console says so rather
   * than calling this "delete".
   */
  app.delete('/api/admin/devices/:deviceId', async (req, reply) => {
    if (!rooms.removeDevice(req.pid, req.params.deviceId)) {
      return reply.code(404).send({ error: '设备不存在' });
    }
    return { ok: true, ...rooms.roster(viewPid(req), { includeUnassigned: req.isPlatform }) };
  });

  /** Create or edit a room. */
  app.post('/api/admin/rooms', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    const { roomId, ...patch } = req.body ?? {};
    try {
      rooms.saveRoom(pid, roomId, patch);
      return { ok: true, ...rooms.roster(viewPid(req), { includeUnassigned: req.isPlatform }) };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  /** Delete a room. Refused while a box is still in it - see rooms.js. */
  app.delete('/api/admin/rooms/:roomId', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    const r = rooms.removeRoom(pid, req.params.roomId);
    if (!r.ok) return reply.code(409).send({ error: r.reason });
    return { ok: true, ...rooms.roster(viewPid(req), { includeUnassigned: req.isPlatform }) };
  });

  /**
   * Check-in and check-out.
   *
   * Check-out is not just "clear the name": it also takes back whatever the
   * departing guest was allowed to unlock. See rooms.js.
   */
  app.post('/api/admin/rooms/:roomId/checkin', async (req, reply) => {
    try {
      const pid = target(req, reply);
      if (pid === undefined) return;
      rooms.checkIn(pid, req.params.roomId, req.body?.guestName);
      return { ok: true, ...rooms.roster(viewPid(req), { includeUnassigned: req.isPlatform }) };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  app.post('/api/admin/rooms/:roomId/checkout', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    if (!rooms.checkOut(pid, req.params.roomId)) {
      return reply.code(404).send({ error: '房间不存在' });
    }
    return { ok: true, ...rooms.roster(viewPid(req), { includeUnassigned: req.isPlatform }) };
  });

  // --------------------------------------------------------------- 收款

  /**
   * 收款那一页要的全部。
   *
   * 密钥不在里面 —— 只有「配没配」。见 pay.channelState。
   */
  app.get('/api/admin/pay', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    return {
      /*
       * 两套通道，各归各的。
       *
       *   channel          这家酒店自己的商户 —— 客人点餐的钱进这里
       *   platformChannel  我们的商户 —— 服务费和观看权进这里，只有平台看得到
       */
      channel: pay.channelState(pay.scopeOf('service', pid)),
      platformChannel: req.isPlatform ? pay.channelState(PLATFORM) : undefined,
      billing: billing.adminState(pid),
      recent: db
      .prepare(
        req.isPlatform
          ? 'SELECT * FROM pay_orders ORDER BY created_at DESC LIMIT 60'
          : 'SELECT * FROM pay_orders WHERE property_id = ? ORDER BY created_at DESC LIMIT 60',
      )
      .all(...(req.isPlatform ? [] : [pid]))
      .map((r) => ({
        orderNo: r.order_no,
        kind: r.kind,
        state: r.state,
        amountText: pay.formatMoney(r.amount_cents, r.currency),
        subject: r.subject,
        roomId: r.room_id,
        note: r.note,
        createdAt: r.created_at,
        paidAt: r.paid_at,
      })),
    };
  });

  app.post('/api/admin/pay/channel', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    // platform:true 改的是我们自己的商户，只有平台管理员能碰。
    if (req.body?.platform && platformOnly(req, reply)) return;
    const scope = req.body?.platform ? PLATFORM : pay.scopeOf('service', pid);
    try {
      return { ok: true, channel: pay.saveChannel(scope, req.body ?? {}), billing: billing.adminState(pid) };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  /** 探一下网关通不通、签名对不对。比等第一个客人付款时才发现要好。 */
  app.post('/api/admin/pay/probe', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    if (req.body?.platform && platformOnly(req, reply)) return;
    return pay.probeChannel(req.body?.platform ? PLATFORM : pay.scopeOf('service', pid));
  });

  /** 手动跑一轮对账。「客人说付了但订单没变」时按这个。 */
  app.post('/api/admin/pay/reconcile', async (req) => pay.reconcile(req.log));

  app.post('/api/admin/billing', async (req, reply) => {
    try {
      const pid = target(req, reply);
      if (pid === undefined) return;
      return { ok: true, billing: billing.save(pid, req.body ?? {}) };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  /** 给一台盒子直接发观看权，不收钱。前台补偿、VIP 房、测试都用得上。 */
  app.post('/api/admin/billing/pass', async (req, reply) => {
    try {
      const r = billing.grantPass(req.pid, req.body?.deviceId, req.body?.days);
      if (!r) return reply.code(404).send({ error: '设备不存在' });
      return { ok: true, contentUntil: r.content_until, ...rooms.roster(viewPid(req), { includeUnassigned: req.isPlatform }) };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  /** 酒店自己扫码续服务费。付完自动延到期日，见 pay.applyEffect。 */
  app.post('/api/admin/billing/invoice', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    const days = Math.trunc(Number(req.body?.days));
    const plan = billing.propertyPlans(pid).find((p) => p.days === days);
    if (!plan) return reply.code(400).send({ error: '没有这一档' });
    try {
      // 服务费进平台商户，但要记清楚是哪家交的 —— 付完只延这一家的到期日。
      const order = await pay.createOrder({
        kind: 'property',
        refId: plan.days,
        propertyId: pid,
        amountCents: pay.toMinor(plan.price, pay.currency(PLATFORM)),
        subject: `${props.find(pid)?.name ?? ''} 服务费 ${plan.days} 天`,
        clientIp: req.ip,
      });
      return { ok: true, payment: order };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  /** 一笔收款现在什么状态，后台轮询用。 */
  app.get('/api/admin/pay/:orderNo', async (req, reply) => {
    const row = pay.findOrder(req.params.orderNo);
    if (!row) return reply.code(404).send({ error: '没有这笔单' });
    if (!req.isPlatform && Number(row.property_id) !== req.pid) {
      return reply.code(404).send({ error: '没有这笔单' });
    }
    return { order: await pay.withQr(row), billing: billing.adminState(req.pid ?? row.property_id) };
  });

  // ----------------------------------------------------------- 客房服务

  app.get('/api/admin/service', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    return {
      menu: svc.menu(pid),
      // 平台管理员看十家的单子，酒店只看自己的。
      orders: svc.orders({ pid: req.pid, limit: Number(req.query?.limit) || 100 }),
      pending: svc.pendingCount(req.pid),
      currency: pay.currency(pay.scopeOf('service', pid)),
      money: svc.currencyCheck(pid),
      statuses: svc.statuses,
    };
  });

  app.post('/api/admin/service/item', async (req, reply) => {
    try {
      const pid = target(req, reply);
      if (pid === undefined) return;
      const id = svc.saveItem(pid, req.body ?? {});
      if (!id) return reply.code(404).send({ error: '菜品不存在' });
      return { ok: true, id, menu: svc.menu(pid) };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  app.delete('/api/admin/service/item/:id', async (req, reply) => {
    const pid = target(req, reply);
    if (pid === undefined) return;
    if (!svc.removeItem(pid, req.params.id)) return reply.code(404).send({ error: '菜品不存在' });
    return { ok: true, menu: svc.menu(pid) };
  });

  app.post('/api/admin/service/currency', async (req, reply) => {
    try {
      const pid = target(req, reply);
      if (pid === undefined) return;
      return { ok: true, currency: svc.setMenuCurrency(pid, req.body?.currency), menu: svc.menu(pid) };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  app.post('/api/admin/service/order/:id', async (req, reply) => {
    try {
      if (!svc.setOrderStatus(req.pid, req.params.id, String(req.body?.status))) {
        return reply.code(404).send({ error: '订单不存在' });
      }
      return { ok: true, orders: svc.orders({ pid: req.pid }), pending: svc.pendingCount(req.pid) };
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  app.post('/api/admin/password', async (req, reply) => {
    // 这是平台总口令。酒店改自己的口令走 /properties/:id/token。
    if (platformOnly(req, reply)) return;
    const next = String(req.body?.token ?? '').trim();
    if (next.length < 8) return reply.code(400).send({ error: '密码至少 8 位' });
    if (config.admin.token) {
      return reply
        .code(409)
        .send({ error: '密码来自 ADMIN_TOKEN 环境变量，请改那里并重启' });
    }
    setSetting(PLATFORM, 'admin.token', next);
    // Takes effect on restart: the token was resolved once at boot.
    return { ok: true, restartRequired: true };
  });

  app.log.info({ at: now() }, 'admin console mounted at /admin/');
}
