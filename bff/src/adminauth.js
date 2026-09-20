/**
 * 后台的账号、会话、权限和操作记录。
 *
 * 原来只有两个**共用口令**：一个平台的、一家酒店一个。能进来就等于是那个角色，
 * 没有「谁」这个概念 —— 前台三个人共用一个密码，出了事查不出是谁动的，
 * 人走了也没法只收回他一个人的权限。
 *
 * 这里补三件事：
 *
 *   **账号**  一人一个，带角色。前台只能管房间和订单，碰不到收款、品牌、
 *             成人板块 —— 这不是把按钮藏起来，是服务端按路由白名单拦。
 *   **会话**  登录换一张有期限的票，浏览器里存的是票不是密码。
 *             票能吊销（「在别处退出」），密码泄露的补救不再是改 .env 重启。
 *   **记录**  谁、什么时候、动了哪一家的什么。写操作才记，读的不记 ——
 *             记什么都记，等于什么都查不到。
 *
 * **老口令继续有效**，当作平台的保底钥匙：`.env` 里的 `ADMIN_TOKEN` 和
 * 每家酒店自己的口令照旧能登录，只是它们没有「是谁」。账号建起来之后
 * 应该把老口令收进保险箱，而不是发给前台 —— 但把它砍掉会让一个还没建
 * 账号的部署当场锁死自己，所以留着。
 */
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { db, now } from './db.js';

// ------------------------------------------------------------------ 角色

/**
 * 三个角色，按「这个人日常要做什么」分，不是按功能列表分。
 *
 *   platform  我们自己。十家都看得见，能建店、接面板、改平台商户。
 *   manager   酒店老板/店长。自己这一家的全部。
 *   desk      前台。**只有房间和订单** —— 他一天做的就这两件事，
 *             而把收款配置、成人板块、品牌设置交给轮班的人，
 *             是在等一个没人认账的意外。
 */
export const ROLES = ['platform', 'manager', 'desk'];

export const ROLE_NAMES = {
  platform: '平台管理员',
  manager: '酒店管理员',
  desk: '前台',
};

/**
 * 前台够得着的接口。**白名单**，不是黑名单 ——
 * 以后新加的接口默认前台不能用，漏一条的后果是「他点不了」，
 * 而黑名单漏一条的后果是「他把收款改了」。
 */
const DESK_ALLOWED = [
  ['GET', /^\/api\/admin\/(me|state|rooms|service|notices)$/],
  ['POST', /^\/api\/admin\/devices\/[^/]+$/],
  ['POST', /^\/api\/admin\/rooms$/],
  ['DELETE', /^\/api\/admin\/rooms\/[^/]+$/],
  ['POST', /^\/api\/admin\/rooms\/[^/]+\/(checkin|checkout)$/],
  ['POST', /^\/api\/admin\/service\/order\/[^/]+$/],
  ['POST', /^\/api\/admin\/logout$/],
];

/** 只有平台能碰的：别家酒店、面板、平台自己的商户和总口令。 */
const PLATFORM_ONLY = [
  /^\/api\/admin\/properties/,
  /^\/api\/admin\/panels/,
  /^\/api\/admin\/password$/,
];

/**
 * 这次请求，这个角色能不能做。
 *
 * 路径里的查询串要先切掉：`/api/admin/rooms?property=2` 不切就一条都匹配不上，
 * 前台会变成什么都不能做。
 */
export function allowed(role, method, url) {
  const path = String(url || '').split('?')[0];
  if (role === 'platform') return true;
  if (PLATFORM_ONLY.some((re) => re.test(path))) return false;
  if (role === 'manager') return true;
  if (role === 'desk') {
    return DESK_ALLOWED.some(([m, re]) => m === String(method).toUpperCase() && re.test(path));
  }
  return false;
}

// ------------------------------------------------------------------ 账号

const hashPass = (pass, salt) => scryptSync(String(pass), salt, 32).toString('hex');

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    roleName: ROLE_NAMES[u.role] ?? u.role,
    propertyId: u.property_id,
    active: Boolean(u.active),
    createdAt: u.created_at,
    lastLogin: u.last_login,
  };
}

export function listUsers(pid) {
  const rows =
    pid == null
      ? db.prepare('SELECT * FROM admin_users ORDER BY property_id IS NULL DESC, username').all()
      : db.prepare('SELECT * FROM admin_users WHERE property_id = ? ORDER BY username').all(pid);
  return rows.map(publicUser);
}

export function findUser(id) {
  return db.prepare('SELECT * FROM admin_users WHERE id = ?').get(Number(id));
}

/**
 * 建一个账号。
 *
 * 用户名全局唯一，不是「每家酒店里唯一」—— 登录框里只有一个用户名输入框，
 * 两家酒店各有一个 `admin` 的话，那一刻没人说得清该进哪一家。
 */
export function createUser({ username, password, role, propertyId }) {
  const name = String(username ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(name)) {
    throw Object.assign(new Error('用户名 3-32 位，只能用字母数字和 . _ -'), { statusCode: 400 });
  }
  if (!ROLES.includes(role)) {
    throw Object.assign(new Error('角色不对'), { statusCode: 400 });
  }
  if (role !== 'platform' && propertyId == null) {
    throw Object.assign(new Error('酒店账号必须属于某一家酒店'), { statusCode: 400 });
  }
  checkPassword(password);
  if (db.prepare('SELECT 1 FROM admin_users WHERE username = ?').get(name)) {
    throw Object.assign(new Error('这个用户名已经有人用了'), { statusCode: 409 });
  }

  const salt = randomBytes(16).toString('hex');
  const r = db
    .prepare(
      `INSERT INTO admin_users (property_id, username, pass_hash, pass_salt, role, active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(role === 'platform' ? null : Number(propertyId), name, hashPass(password, salt), salt, role, now());
  return publicUser(findUser(r.lastInsertRowid));
}

export function checkPassword(pass) {
  const p = String(pass ?? '');
  if (p.length < 8) {
    throw Object.assign(new Error('密码至少 8 位'), { statusCode: 400 });
  }
  // 常见到没有意义的几个。挡不住认真的攻击，但挡得住「随手设一个」。
  if (['12345678', 'password', 'admin123', '11111111'].includes(p.toLowerCase())) {
    throw Object.assign(new Error('这个密码太常见了，换一个'), { statusCode: 400 });
  }
}

export function setPassword(id, password) {
  checkPassword(password);
  const salt = randomBytes(16).toString('hex');
  db.prepare('UPDATE admin_users SET pass_hash = ?, pass_salt = ? WHERE id = ?')
    .run(hashPass(password, salt), salt, Number(id));
  // 改了密码，之前发出去的票一律作废 —— 改密码的常见原因就是「怕别人还在里面」。
  db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(Number(id));
}

export function setActive(id, active) {
  db.prepare('UPDATE admin_users SET active = ? WHERE id = ?').run(active ? 1 : 0, Number(id));
  if (!active) db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(Number(id));
}

export function removeUser(id) {
  db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(Number(id));
  return db.prepare('DELETE FROM admin_users WHERE id = ?').run(Number(id)).changes > 0;
}

/** 拿用户名密码换一个账号。停用的账号一律不认。 */
export function authenticate(username, password) {
  const name = String(username ?? '').trim().toLowerCase();
  if (!name) return null;
  const u = db.prepare('SELECT * FROM admin_users WHERE username = ? AND active = 1').get(name);
  if (!u) return null;
  const a = Buffer.from(hashPass(password, u.pass_salt), 'hex');
  const b = Buffer.from(u.pass_hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  db.prepare('UPDATE admin_users SET last_login = ? WHERE id = ?').run(now(), u.id);
  return u;
}

export function anyUsers() {
  return db.prepare('SELECT COUNT(*) n FROM admin_users WHERE active = 1').get().n > 0;
}

// ------------------------------------------------------------------ 会话

/** 闲置多久作废。前台一天开好几次，太短就是在教他们把密码写在便签上。 */
const IDLE_MS = 7 * 86400 * 1000;
/** 最长活多久。不管用得多勤，到期都要重新登录一次。 */
const ABSOLUTE_MS = 30 * 86400 * 1000;

/** 库里存的是票的哈希。库被看一眼不等于别人能拿着票进来。 */
const digest = (raw) => createHash('sha256').update(String(raw)).digest('hex');

export function startSession(who, meta = {}) {
  const raw = randomBytes(24).toString('base64url');
  db.prepare(
    `INSERT INTO admin_sessions (token_hash, user_id, property_id, role, label, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    digest(raw),
    who.userId ?? null,
    who.propertyId ?? null,
    who.role,
    String(meta.label ?? '').slice(0, 80) || null,
    Date.now(),
    Date.now(),
  );
  return raw;
}

/**
 * 一张票换一个身份。
 *
 * 顺手把 `last_seen` 往前推 —— 闲置过期靠的就是它。每次请求写一行会有点吵，
 * 所以**一分钟之内不重复写**：过期判断的精度要的是「天」，不是「秒」。
 */
export function resolveSession(raw) {
  if (!raw) return null;
  const row = db.prepare('SELECT * FROM admin_sessions WHERE token_hash = ?').get(digest(raw));
  if (!row) return null;

  const nowMs = Date.now();
  if (nowMs - row.created_at > ABSOLUTE_MS || nowMs - row.last_seen > IDLE_MS) {
    db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }

  // 账号被停用或删了，手里的票立刻不作数。
  let user = null;
  if (row.user_id != null) {
    user = findUser(row.user_id);
    if (!user || !user.active) {
      db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(row.token_hash);
      return null;
    }
  }

  if (nowMs - row.last_seen > 60_000) {
    db.prepare('UPDATE admin_sessions SET last_seen = ? WHERE token_hash = ?').run(nowMs, row.token_hash);
  }

  return {
    userId: row.user_id,
    username: user?.username ?? null,
    role: user?.role ?? row.role,
    propertyId: user ? user.property_id : row.property_id,
    sessionHash: row.token_hash,
  };
}

export function endSession(raw) {
  if (!raw) return;
  db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(digest(raw));
}

export function sessionsOf(userId) {
  return db
    .prepare('SELECT token_hash, label, created_at, last_seen FROM admin_sessions WHERE user_id = ? ORDER BY last_seen DESC')
    .all(Number(userId))
    .map((r) => ({ id: r.token_hash.slice(0, 12), label: r.label, createdAt: r.created_at, lastSeen: r.last_seen }));
}

/** 「把所有地方都退出去」。丢了手机、或者觉得有人还在里面时用。 */
export function endAllSessions(userId) {
  return db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(Number(userId)).changes;
}

export function sweepSessions() {
  const nowMs = Date.now();
  return db
    .prepare('DELETE FROM admin_sessions WHERE ? - created_at > ? OR ? - last_seen > ?')
    .run(nowMs, ABSOLUTE_MS, nowMs, IDLE_MS).changes;
}

// -------------------------------------------------------------- 登录限速

/**
 * 试错限速。
 *
 * 这个控制台挂在公网域名上，而原来登录接口是**无限次可以猜的** ——
 * 一个八位口令配上一条家用宽带，慢慢跑也就是几天的事。
 *
 * 按「IP + 用户名」两个维度各记一份：只按 IP 挡，一个内网出口的酒店会互相
 * 拖累；只按用户名挡，换个名字接着撞库。次数越多等得越久，封顶半小时 ——
 * 不做永久锁定，那等于给了外人一个「把前台锁在门外」的按钮。
 */
const LOCK_STEPS = [
  [5, 60_000],
  [8, 5 * 60_000],
  [12, 15 * 60_000],
  [20, 30 * 60_000],
];

function lockRow(key) {
  return db.prepare('SELECT * FROM admin_lockout WHERE key = ?').get(String(key));
}

/** 还要等多少毫秒。0 = 可以试。 */
export function lockedFor(keys) {
  let wait = 0;
  for (const k of keys) {
    const r = lockRow(k);
    if (r?.until) wait = Math.max(wait, r.until - Date.now());
  }
  return Math.max(0, wait);
}

export function noteFail(keys) {
  for (const k of keys) {
    const r = lockRow(k);
    const fails = (r?.fails ?? 0) + 1;
    let until = 0;
    for (const [n, ms] of LOCK_STEPS) if (fails >= n) until = Date.now() + ms;
    db.prepare(
      `INSERT INTO admin_lockout (key, fails, until, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, until = excluded.until, updated_at = excluded.updated_at`,
    ).run(String(k), fails, until, Date.now());
  }
}

export function clearFail(keys) {
  for (const k of keys) db.prepare('DELETE FROM admin_lockout WHERE key = ?').run(String(k));
}

// ------------------------------------------------------------ 操作记录

/** 不往记录里写的字段名。记录本身不该变成第二个泄密的地方。 */
const SECRET_KEYS = /token|password|secret|pin|key/i;

function summarize(body) {
  if (!body || typeof body !== 'object') return '';
  const bits = [];
  for (const [k, v] of Object.entries(body)) {
    if (SECRET_KEYS.test(k)) {
      bits.push(`${k}=***`);
      continue;
    }
    if (v == null) continue;
    if (typeof v === 'object') {
      bits.push(`${k}={…}`);
      continue;
    }
    bits.push(`${k}=${String(v).slice(0, 40)}`);
  }
  return bits.join(' ').slice(0, 300);
}

/**
 * 记一笔。**只记写操作、只记成功的**。
 *
 * 读也记的话，一天几千行翻不动，真要查「谁把房间的成人区打开了」反而找不着。
 */
export function record({ who, method, url, body, propertyId, status }) {
  if (String(method).toUpperCase() === 'GET') return;
  if (status >= 400) return;
  db.prepare(
    `INSERT INTO admin_audit (at, user_id, username, role, property_id, method, path, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    now(),
    who?.userId ?? null,
    who?.username ?? (who?.role === 'platform' ? '（平台口令）' : '（酒店口令）'),
    who?.role ?? '?',
    propertyId ?? null,
    String(method).toUpperCase(),
    String(url).split('?')[0].slice(0, 200),
    summarize(body),
  );
}

export function auditList(pid, limit = 200) {
  const rows =
    pid == null
      ? db.prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?').all(Math.min(Number(limit) || 200, 500))
      : db
          .prepare('SELECT * FROM admin_audit WHERE property_id = ? ORDER BY id DESC LIMIT ?')
          .all(pid, Math.min(Number(limit) || 200, 500));
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    username: r.username,
    role: r.role,
    roleName: ROLE_NAMES[r.role] ?? r.role,
    propertyId: r.property_id,
    method: r.method,
    path: r.path,
    summary: r.summary,
  }));
}

/** 半年前的删掉。够查一次纠纷，也不会把库撑大。 */
const AUDIT_KEEP_DAYS = 180;

export function sweepAudit() {
  return db.prepare('DELETE FROM admin_audit WHERE at < ?').run(now() - AUDIT_KEEP_DAYS * 86400).changes;
}
