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

    if (tokenMatches(given, token)) {
      req.isPlatform = true;
      req.property = null;
      req.pid = null;
      return;
    }

    const p = props.authenticate(given);
    if (p) {
      req.isPlatform = false;
      req.property = p;
      req.pid = p.id;
      return;
    }

    return reply.code(401).send({ error: '未授权' });
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

  // Exists so the console can tell a wrong password from a broken server.
  app.post('/api/admin/login', async (req, reply) => {
    const given = req.body?.token;
    if (tokenMatches(given, token)) {
      return { ok: true, scope: 'platform', properties: props.overview() };
    }
    const p = props.authenticate(given);
    if (p) return { ok: true, scope: 'property', property: props.publicProperty(p) };
    return reply.code(401).send({ error: '密码不对' });
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

    const arr = (v) => (Array.isArray(v) ? v : []);
    let live = [], movies = [], series = [], liveCats = [], vodCats = [], seriesCats = [];
    try {
      [liveCats, live, vodCats, movies, seriesCats, series] = await Promise.all([
        xui.liveCategories(user, pass),
        xui.liveStreams(user, pass),
        xui.vodCategories(user, pass),
        xui.vodStreams(user, pass),
        xui.seriesCategories(user, pass),
        xui.seriesList(user, pass),
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

  /** Edit one box: its room, its label, the line it streams through. */
  app.post('/api/admin/devices/:deviceId', async (req, reply) => {
    try {
      const dev = rooms.saveDevice(req.pid, req.params.deviceId, req.body ?? {});
      if (!dev) return reply.code(404).send({ error: '设备不存在' });
      return { ok: true, ...rooms.roster(viewPid(req), { includeUnassigned: req.isPlatform }) };
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
