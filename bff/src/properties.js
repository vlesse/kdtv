/**
 * 酒店。
 *
 * 一台服务器、一个 APK、很多家酒店。盒子里烧死的地址只有一个，十家酒店的电视
 * 都打到这里，所以「这台盒子是哪家的」必须由服务端认出来 —— 靠的是
 * `devices.property_id`，在配对那一刻写进去。
 *
 * 一家酒店拥有的东西：
 *
 *   品牌   名字、logo、各页面背景          → settings（按 property_id 分）
 *   线路   XUI 账号，决定片库              → 这张表上，留空则用平台默认
 *   菜单   菜品、价格、币种                → service_items.property_id
 *   计费   谁出钱、到期日、档位            → settings
 *   收款   点餐的钱进它自己的商户          → settings（见 pay.js 的 scope）
 *   账号   前台自己的后台口令              → 这张表上的 scrypt 摘要
 *
 * **钱的归属有一条固定规则**：内容的钱归平台，餐食的钱归酒店。
 * 酒店交的服务费（property）和客人买的观看权（unlock）走平台商户；
 * 客人点餐（service）走这家酒店自己的商户。所以收款通道有两套，不是一套。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, now, PLATFORM } from './db.js';
import { config } from './config.js';
import { setSetting } from './settings.js';
import * as panels from './panels.js';

const SLUG = /^[a-z0-9][a-z0-9-]{1,30}$/;

const text = (v, max = 80) => {
  const s = String(v ?? '').trim().slice(0, max);
  return s || null;
};

export const find = (id) =>
  db.prepare('SELECT * FROM properties WHERE id = ?').get(Number(id)) ?? null;

export const findBySlug = (slug) =>
  db.prepare('SELECT * FROM properties WHERE slug = ?').get(String(slug ?? '')) ?? null;

export const all = () => db.prepare('SELECT * FROM properties ORDER BY name, id').all();

/** 有没有酒店。全新安装是空的，第一家由操作员在后台建。 */
export const any = () => db.prepare('SELECT COUNT(*) n FROM properties').get().n > 0;

/**
 * 一家酒店，后台列表里的样子。
 *
 * 口令和线路密码永远不出现在这里 —— 这个后台开在公网域名上。
 */
export function publicProperty(p, extra = {}) {
  if (!p) return null;
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    contact: p.contact,
    line: p.line_user || null,
    usesDefaultLine: !p.line_user,
    // 这家走哪台面板。`panelId` 为 null = 没指定，跟平台默认那台 ——
    // 而 `panelName` 不管指不指定都是实际在用的那一台，因为后台要回答的是
    // 「它现在从哪台机器拿片」，不是「表里这格填了没」。
    panelId: p.panel_id ?? null,
    panelName: panels.forProperty(p)?.name ?? null,
    hasLogin: Boolean(p.token_hash),
    active: Boolean(p.active),
    createdAt: p.created_at,
    ...extra,
  };
}

export function create({ slug, name, contact }) {
  const s = String(slug ?? '').trim().toLowerCase();
  if (!SLUG.test(s)) {
    throw Object.assign(
      new Error('标识要 2-31 位小写字母/数字/连字符，比如 angkor-grand —— 它会出现在日志和登录里'),
      { statusCode: 400 },
    );
  }
  if (findBySlug(s)) throw Object.assign(new Error('这个标识已经有人用了'), { statusCode: 409 });

  const n = text(name);
  if (!n) throw Object.assign(new Error('酒店名字必填'), { statusCode: 400 });

  const info = db
    .prepare('INSERT INTO properties (slug, name, contact, active, created_at) VALUES (?, ?, ?, 1, ?)')
    .run(s, n, text(contact, 120), now());
  const id = Number(info.lastInsertRowid);

  /*
   * 名字立刻写进这家自己的配置。
   *
   * 不写的话，homeConfig 会回落到环境变量里的默认名 —— 新开的「湄公河酒店」
   * 电视上显示的是「KDTV」，而运营会以为自己已经填过名字了。
   */
  setSetting(id, 'home.propertyName', n);
  return find(id);
}

export function save(id, patch = {}) {
  const p = find(id);
  if (!p) return null;

  const sets = [];
  const args = [];

  if ('name' in patch) {
    const n = text(patch.name);
    if (!n) throw Object.assign(new Error('酒店名字不能清空'), { statusCode: 400 });
    sets.push('name = ?');
    args.push(n);
    /*
     * 改名字连电视上那个也一起改。
     *
     * 这两个值以前是分开的：一个是后台列表里的标签，一个是电视首页显示的
     * 名字。谁都不会想到改了一个还要去另一个地方再改一次 —— 结果就是后台
     * 写着「湄公河酒店」，客房电视上还挂着上一家的名字。
     *
     * 想让电视上显示得跟后台不一样（比如带个英文副标题），改完名字再去
     * 「文字」那一栏单独调；下次再改名字会覆盖回来。
     */
    setSetting(p.id, 'home.propertyName', n);
  }
  if ('contact' in patch) {
    sets.push('contact = ?');
    args.push(text(patch.contact, 120));
  }
  if ('active' in patch) {
    sets.push('active = ?');
    args.push(patch.active ? 1 : 0);
  }

  /*
   * 换线路 = 换这家能看到的整个片库。
   *
   * 账号和密码要么一起给，要么一起清（清了就回落到平台默认线路）。
   * 半个凭证认证不了任何东西，存下来只会得到一家「看着配好了、什么都放不出来」
   * 的酒店。
   */
  if ('lineUser' in patch || 'linePass' in patch) {
    const user = text(patch.lineUser, 64);
    const pass = text(patch.linePass, 128);
    if (user && !pass) {
      throw Object.assign(new Error('换线路要同时填账号和密码'), { statusCode: 400 });
    }
    sets.push('line_user = ?', 'line_pass = ?');
    args.push(user, user ? pass : null);
  }

  /*
   * 换面板 = 换“从哪台机器拿片”。
   *
   * 和换线路是两回事，但两者绑在一起：一条线路只在它自己那台面板上
   * 有效。所以换面板而不同时换线路，很可能得到一家认证不过的酒店 ——
   * 这件事控制台必须当场说出来，不能等到客人对着黑屏才发现。
   */
  if ('panelId' in patch) {
    const target = patch.panelId == null || patch.panelId === '' ? null : Number(patch.panelId);
    if (target != null && !panels.find(target)) {
      throw Object.assign(new Error('没有这台面板'), { statusCode: 400 });
    }
    sets.push('panel_id = ?');
    args.push(target);
  }

  if (sets.length) {
    db.prepare(`UPDATE properties SET ${sets.join(', ')} WHERE id = ?`).run(...args, p.id);
  }
  return find(p.id);
}

/**
 * 这家酒店实际使用的 XUI 线路。
 *
 * 自己有就用自己的，没有就用平台默认的 —— 十家默认看同一套，
 * 哪家要不一样就单独给它绑一条。
 */
export function lineFor(property) {
  if (property?.line_user && property?.line_pass) {
    return { username: property.line_user, password: property.line_pass };
  }
  return { username: config.defaultLine.username, password: config.defaultLine.password };
}

/**
 * 这家酒店走哪台面板。没指定就是平台默认那台。
 */
export function panelFor(property) {
  return panels.forProperty(property);
}

/**
 * 一台盒子拿片单时要用的全部东西：账号、密码，和它在哪台面板上。
 *
 * `xui.js` 里每个函数收的就是这个对象。**账号密码和面板必须一起走** ——
 * 同一对账号密码在另一台面板上要么认不过、要么是另一批内容，
 * 分开传早晚会抄错一半。
 *
 * 线路用盒子自己存的那一份（hello 会把酒店的线路发给它），
 * 面板则永远按它所属的酒店算：面板是“从哪台机器拿”，那是酒店的属性，
 * 不是某一台盒子能自己决定的。
 */
export function lineOf(dev) {
  const property = dev?.property_id != null ? find(dev.property_id) : null;
  const panel = panels.forProperty(property);
  return {
    username: dev?.line_user ?? '',
    password: dev?.line_pass ?? '',
    api: panel?.api_base ?? '',
    pub: String(panel?.public_base ?? '').replace(/\/+$/, ''),
    panelId: panel?.id ?? 0,
    panelName: panel?.name ?? '',
  };
}

/**
 * 这家酒店自己去问面板时用的 line 对象（后台读分类走的就是这条路）。
 * 和盒子走的是同一台面板、同一条线路 —— 否则后台勾的分类 id
 * 在电视上根本对不上号。
 */
export function callLineFor(property) {
  const l = lineFor(property);
  return lineOf({
    property_id: property?.id ?? null,
    line_user: l.username,
    line_pass: l.password,
  });
}

// ------------------------------------------------------------------ 登录

/**
 * 每家酒店自己的后台口令。
 *
 * 存的是 scrypt 摘要。前台会把这个口令写在便签上贴在电脑边 —— 那没关系，
 * 它只能打开自己这一家；能看到十家的那个口令是平台的 ADMIN_TOKEN，
 * 从来不发给酒店。
 */
export function setToken(id, token) {
  const p = find(id);
  if (!p) return null;
  const t = String(token ?? '').trim();
  if (!t) {
    db.prepare('UPDATE properties SET token_hash = NULL, token_salt = NULL WHERE id = ?').run(p.id);
    return find(p.id);
  }
  if (t.length < 8) throw Object.assign(new Error('口令至少 8 位'), { statusCode: 400 });

  const salt = randomBytes(16).toString('hex');
  db.prepare('UPDATE properties SET token_hash = ?, token_salt = ? WHERE id = ?').run(
    scryptSync(t, salt, 32).toString('hex'),
    salt,
    p.id,
  );
  return find(p.id);
}

/**
 * 拿一个口令换一家酒店。
 *
 * 遍历所有酒店逐个比对 —— 十家、几十家的规模下这是最简单也最难写错的做法，
 * 而且每一次比较都是定长的，不会因为「第几家匹配上」而泄露时间差。
 * 停用的酒店（active = 0）不参与，等于把它的后台关掉但数据留着。
 */
export function authenticate(token) {
  const t = String(token ?? '');
  if (!t) return null;

  for (const p of db.prepare('SELECT * FROM properties WHERE active = 1').all()) {
    if (!p.token_hash || !p.token_salt) continue;
    const a = scryptSync(t, p.token_salt, 32);
    const b = Buffer.from(p.token_hash, 'hex');
    if (a.length === b.length && timingSafeEqual(a, b)) return p;
  }
  return null;
}

// ------------------------------------------------------------------ 概览

/**
 * 总后台第一眼要看到的：十家分别怎么样。
 *
 * 到期、欠费、有没有盒子在线 —— 这些是「该给谁打电话」的依据，
 * 所以放在一个请求里，不用点进每一家才知道。
 */
export function overview() {
  const rows = all();
  const stat = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM devices d WHERE d.property_id = ?) AS boxes,
      (SELECT COUNT(*) FROM devices d WHERE d.property_id = ? AND d.last_seen > ?) AS recent,
      (SELECT COUNT(*) FROM rooms r WHERE r.property_id = ? AND r.checked_in = 1) AS occupied,
      (SELECT COUNT(*) FROM orders o WHERE o.property_id = ? AND o.status IN ('new','paid','doing')) AS pendingOrders
  `);
  const weekAgo = now() - 7 * 86400;

  return rows.map((p) => {
    const s = stat.get(p.id, p.id, weekAgo, p.id, p.id);
    return publicProperty(p, {
      boxes: s.boxes,
      /** 一周内开过机的盒子。hello 只在开机时调一次，所以这不是「在线」。 */
      recentBoxes: s.recent,
      occupiedRooms: s.occupied,
      pendingOrders: s.pendingOrders,
    });
  });
}

/**
 * 删掉一家酒店。
 *
 * 连同它的房间、菜单、订单、通知、配置一起。盒子不删，只是解绑 ——
 * 那些是真实存在的硬件，下次开机会重新出配对码，可以分给别家。
 */
export function remove(id) {
  const p = find(id);
  if (!p) return false;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE devices SET property_id = NULL, room_id = NULL, line_user = NULL, line_pass = NULL, code = NULL WHERE property_id = ?').run(p.id);
    for (const t of ['rooms', 'service_items', 'orders', 'notices', 'settings', 'pay_orders']) {
      try {
        db.prepare(`DELETE FROM ${t} WHERE property_id = ?`).run(p.id);
      } catch {
        /* pay_orders 是 pay.js 建的，导入顺序不同时可能还不存在 */
      }
    }
    db.prepare('DELETE FROM properties WHERE id = ?').run(p.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return true;
}

export { PLATFORM };
