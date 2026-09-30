// Device identity and pairing. The whole point of this module is that a
// guest never types a server address: the box knows only this service's URL
// (baked into the APK), announces itself, and gets everything else back.
import { createHash, timingSafeEqual } from 'node:crypto';
import { db, now, PLATFORM } from './db.js';
import { getSetting, setSetting } from './settings.js';
import * as properties from './properties.js';

const CODE_ALPHABET = '0123456789';

function freshCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let c = '';
    for (let i = 0; i < 6; i++) {
      c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    const taken = db.prepare('SELECT 1 FROM devices WHERE code = ?').get(c);
    if (!taken) return c;
  }
  throw new Error('could not allocate a pairing code');
}

export function getDevice(deviceId) {
  return db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
}

/**
 * 一台新盒子该归哪家酒店。
 *
 * 十家酒店共用一个 APK，所以插电开机的那一刻，服务端只知道「有一台新盒子」，
 * 不知道它在谁的楼里。两条线索，依次试：
 *
 *  1. **平台设了默认酒店** —— 一次只铺一家的时候把它设上，整批盒子插电即用，
 *     现场一个字都不用输。铺完记得清掉，否则下一家的盒子会进错门 ——
 *     **也别一直开着**：它开着的时候，谁拿浏览器打开电视界面都能直接看。
 *  2. **没有** —— 留在未分配池里，屏幕上显示配对码，等人在后台把它
 *     划给某一家。这是十家同时在跑时唯一安全的默认。
 *
 * 原来还有第一条「同一个 MAC 以前配过就按原样接回去（连房间一起）」，删掉了：
 * MAC 不是秘密 —— 在同一个网里扫一下就有，贴在盒子背面，系统设置里也看得到。
 * 于是任何人报一个新设备号、再报上某台已经配好的盒子的 MAC，就直接进了那家
 * 酒店的那间房：能看、能以那间房的名义点餐、看得见住客姓名，而且会绕开设备
 * 密钥 —— 新设备号第一次来本来就是现领一把钥匙。线上 23 台里只有 1 台报过
 * MAC，这条路从来没真正走过。恢复出厂的盒子现在照样出配对码；后台会提示
 * 「这台的 MAC 和某某房那台一样」，一步就能接回去（见 rooms.roster）。
 */
function adopt() {
  const fallback = Number(getSetting(PLATFORM, 'devices.defaultProperty') ?? 0);
  if (fallback && properties.find(fallback)) return { propertyId: fallback, roomId: null };

  return { propertyId: null, roomId: null };
}

/**
 * Called on every boot. Registers the box if new, adopts it into a property
 * when it can, and otherwise leaves it pending with a code.
 */
export function hello({ deviceId, mac, label }) {
  let dev = getDevice(deviceId);

  if (!dev) {
    const home = adopt();
    db.prepare(`
      INSERT INTO devices (device_id, mac, code, property_id, room_id, line_user, line_pass, label, last_seen, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
    `).run(
      deviceId,
      mac ?? null,
      home.propertyId ? null : freshCode(),
      home.propertyId,
      home.roomId,
      label ?? null,
      now(),
      now(),
    );
    dev = getDevice(deviceId);
  } else {
    db.prepare('UPDATE devices SET last_seen = ?, mac = COALESCE(?, mac) WHERE device_id = ?')
      .run(now(), mac ?? null, deviceId);
    dev = getDevice(deviceId);
    // 没归属、也没有配对码的盒子（比如被放回去的那些），电视上会显示「------」，
    // 前台没法配。补一个。
    if (!dev.property_id && !dev.code) {
      db.prepare('UPDATE devices SET code = ? WHERE device_id = ?').run(freshCode(), deviceId);
      dev = getDevice(deviceId);
    }
  }

  /*
   * 线路跟着酒店走，不再跟着盒子走。
   *
   * 以前每台盒子自己存一份线路凭证，那是单店时代的做法：换线路要挨台改。
   * 现在线路是酒店的属性，盒子每次开机按自己所属的酒店取一次 —— 给某家换
   * 片库是改一行，不是改三百台。
   *
   * 没有归属的盒子就是没有线路，屏幕上停在配对码那一页。这是对的：
   * 在十家同时跑的服务器上，一台不知道属于谁的盒子不该看到任何人的内容。
   */
  /*
   * `line_pinned` = 后台给这一台单独指定过线路，开机时就不要拿酒店的盖回去。
   *
   * 没有这一判断的时候实测过：后台改完看着生效了，盒子下次开机又被这里改回去，
   * 而界面上写的是「盒子重启后生效」—— 正好说反了。
   * 后台说明里「两层楼绑两条不同线路」这个用法，靠的就是它。
   */
  if (dev.property_id && !dev.line_pinned) {
    const line = properties.lineFor(properties.find(dev.property_id));
    if (line.username && (dev.line_user !== line.username || dev.line_pass !== line.password)) {
      db.prepare('UPDATE devices SET line_user = ?, line_pass = ?, code = NULL WHERE device_id = ?')
        .run(line.username, line.password, deviceId);
      dev = getDevice(deviceId);
    }
  }

  return dev;
}

export function bind(deviceId, { lineUser, linePass, roomId, label, propertyId }) {
  db.prepare(`
    UPDATE devices
       SET line_user   = COALESCE(?, line_user),
           line_pass   = COALESCE(?, line_pass),
           room_id     = COALESCE(?, room_id),
           label       = COALESCE(?, label),
           property_id = COALESCE(?, property_id),
           code        = NULL
     WHERE device_id = ?
  `).run(
    lineUser ?? null,
    linePass ?? null,
    roomId ?? null,
    label ?? null,
    propertyId ?? null,
    deviceId,
  );
  return getDevice(deviceId);
}

export function bindByCode(code, payload) {
  const dev = db.prepare('SELECT * FROM devices WHERE code = ?').get(code);
  if (!dev) return null;
  return bind(dev.device_id, payload);
}

export function listDevices(pid = null) {
  return db
    .prepare(
      pid == null
        ? 'SELECT * FROM devices ORDER BY created_at DESC'
        : 'SELECT * FROM devices WHERE property_id = ? ORDER BY created_at DESC',
    )
    .all(...(pid == null ? [] : [pid]));
}

export function isBound(dev) {
  // 归属和线路都要有。只有线路没有酒店的盒子（从单店版升级上来的残留）
  // 会被当成没激活 —— 它的房间、菜单、计费都无处可查。
  return Boolean(dev?.line_user && dev?.line_pass && dev?.property_id);
}

/**
 * 清掉「从来没用起来过」的盒子。
 *
 * 开机报到不要凭据，所以谁拿浏览器打开电视界面都会留下一行：线上实测
 * 差不多每天一台，多半是 AWS 上的链接预览和扫描器，偶尔是真人。它们
 * 停在配对码那一屏，什么都看不了，但会一直挂在后台的房间表里，还占着
 * 一个六位的配对码。
 *
 * **只删真正什么都没有的**：没房间、没线路、没单独指定过线路、没成人授权、
 * 没买过观看权，而且一个月没再出现。任何一样被人动过的盒子都不碰 ——
 * 就算它是真的一台盒子被误删了，下次开机也只是重新报到、重新出一个码。
 */
export function sweepStale(days = 30) {
  const cutoff = now() - days * 86400;
  const r = db
    .prepare(
      `DELETE FROM devices
        WHERE room_id IS NULL
          AND line_user IS NULL
          AND COALESCE(line_pinned, 0) = 0
          AND COALESCE(adult_allowed, 0) = 0
          AND COALESCE(content_until, 0) = 0
          AND last_seen < ?`,
    )
    .run(cutoff);
  return Number(r.changes);
}

// ------------------------------------------------------------------ 设备密钥

/*
 * 盒子是谁，原来只靠它自己报上来的设备号 —— 谁知道一台已配好的盒子的设备号，
 * 谁就能冒充它：看电视、拿到带线路口令的播放地址、以那间房的名义点餐、看见
 * 住客姓名。设备号不是秘密：电视的「关于」页上印着，后台房间表里也有。
 *
 * 现在每台盒子多一把**只有它自己知道的钥匙**：
 *
 *   - 钥匙是**盒子自己生成的**（32 字节随机数，存在 WebView 的 localStorage），
 *     每个请求带在 X-Device-Key 里。服务端只存它的 sha256，从来不往外发。
 *   - **第一次报到时认下**（trust on first use）。新盒子的设备号是 ANDROID_ID，
 *     别人事先不可能知道，所以抢在它前面报到这件事不成立。
 *   - 认下之后，**钥匙不对就什么都拿不到**：内容接口 401，报到只回一个「请前台
 *     重新确认」的码，这台盒子的房间、住客、酒店一样都不告诉它。
 *   - 盒子自己丢了钥匙（清了应用数据、重装）也走同一条路：电视上出码，前台在
 *     后台对着码点确认。码是和**那一台电视出示的那把钥匙**绑在一起的 —— 别人
 *     也能凑出一个码，但前台只会确认自己眼前那台电视上的码。
 *
 * **老盒子不用重装 APK。** 钥匙在网页里，服务端部署之后盒子十几分钟内会自己
 * 换上新界面（见 web/src/updater.ts），下一次报到就认下钥匙。还没换上新界面的
 * 盒子在宽限期里照旧能用；宽限期过了，它们会被拒一次，界面自己重新报到、
 * 生成钥匙、认下 —— 不用人管。
 */

const KEY_RE = /^[0-9a-f]{64}$/;
const REKEY_TTL = 24 * 3600;
const REKEY_KEEP = 5;

const hashKey = (key) => createHash('sha256').update(String(key)).digest('hex');

/** 请求头里的钥匙；形状不对就当没带。 */
export function keyFrom(req) {
  const k = String(req?.headers?.['x-device-key'] ?? '').trim().toLowerCase();
  return KEY_RE.test(k) ? k : null;
}

function sameHash(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * 宽限期：还没认下钥匙的老盒子，到什么时候为止照旧放行。
 *
 * 第一次跑到这个版本的那一刻开始算，默认 14 天。存在 settings 里，
 * 这样重启、部署都不会把起点往后推。DEVICE_KEY_GRACE_UNTIL（unix 秒）
 * 可以直接指定终点 —— 自检脚本靠它测「宽限期过了」。
 */
function graceUntil() {
  const forced = Number(process.env.DEVICE_KEY_GRACE_UNTIL);
  if (Number.isFinite(forced) && forced > 0) return forced;
  let v = Number(getSetting(PLATFORM, 'devices.keyGraceUntil') ?? 0);
  if (!v) {
    const days = Number(process.env.DEVICE_KEY_GRACE_DAYS ?? 14);
    v = now() + Math.max(0, days) * 86400;
    setSetting(PLATFORM, 'devices.keyGraceUntil', String(v));
  }
  return v;
}

export const keyGraceUntil = () => graceUntil();

/**
 * 这一次请求带的钥匙，对这台盒子来说算什么：
 *
 *   'ok'      认下过钥匙，而且对得上
 *   'legacy'  还没认下过钥匙，宽限期内 —— 照旧放行
 *   'bad'     认下过钥匙却对不上 / 没带；或者宽限期过了还没钥匙
 */
export function keyVerdict(dev, key) {
  if (!dev) return 'bad';
  if (!dev.key_hash) return now() < graceUntil() ? 'legacy' : 'bad';
  return key && sameHash(dev.key_hash, hashKey(key)) ? 'ok' : 'bad';
}

/** 还没认下过钥匙的盒子，认下这一把。已经有钥匙的不动。 */
export function adoptKey(deviceId, key) {
  if (!key) return false;
  const r = db
    .prepare('UPDATE devices SET key_hash = ? WHERE device_id = ? AND key_hash IS NULL')
    .run(hashKey(key), deviceId);
  return r.changes > 0;
}

function freshRekeyCode(deviceId) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    const taken = db.prepare('SELECT 1 FROM device_rekeys WHERE device_id = ? AND code = ?').get(deviceId, c);
    if (!taken) return c;
  }
  throw new Error('could not allocate a rekey code');
}

/**
 * 一台认下过钥匙的盒子，拿着另一把钥匙来了：给它一个码，等前台确认。
 *
 * **同一把钥匙再来，给同一个码** —— 电视重启、客人按刷新，屏幕上的码不能变，
 * 否则前台照着屏幕输进去的永远是上一个。
 */
export function requestRekey(deviceId, key) {
  if (!key) return null;
  const h = hashKey(key);
  db.prepare('DELETE FROM device_rekeys WHERE created_at < ?').run(now() - REKEY_TTL);

  const same = db
    .prepare('SELECT code FROM device_rekeys WHERE device_id = ? AND key_hash = ?')
    .get(deviceId, h);
  if (same) return same.code;

  const code = freshRekeyCode(deviceId);
  db.prepare('INSERT INTO device_rekeys (device_id, code, key_hash, created_at) VALUES (?, ?, ?, ?)').run(
    deviceId,
    code,
    h,
    now(),
  );
  // 同一台最多留几条：有人拿着设备号不停换钥匙来刷，也刷不出一张长表。
  db.prepare(
    `DELETE FROM device_rekeys WHERE device_id = ? AND rowid NOT IN (
       SELECT rowid FROM device_rekeys WHERE device_id = ? ORDER BY created_at DESC LIMIT ${REKEY_KEEP})`,
  ).run(deviceId, deviceId);
  return code;
}

export function pendingRekeys(deviceId) {
  return db
    .prepare('SELECT COUNT(*) n FROM device_rekeys WHERE device_id = ? AND created_at >= ?')
    .get(deviceId, now() - REKEY_TTL).n;
}

/**
 * 前台照着电视上的码点了确认：这台电视出示的那把钥匙，从此就是这台盒子的钥匙。
 *
 * pid 的意思和别处一样：null 是平台（哪家都行），否则盒子必须是这一家的。
 * 返回 'ok' / 'no-device' / 'bad-code'。
 */
export function confirmRekey(pid, deviceId, code) {
  const dev = getDevice(deviceId);
  if (!dev || (pid != null && dev.property_id !== pid)) return 'no-device';
  const row = db
    .prepare('SELECT key_hash FROM device_rekeys WHERE device_id = ? AND code = ? AND created_at >= ?')
    .get(deviceId, String(code ?? '').trim(), now() - REKEY_TTL);
  if (!row) return 'bad-code';
  db.prepare('UPDATE devices SET key_hash = ? WHERE device_id = ?').run(row.key_hash, deviceId);
  db.prepare('DELETE FROM device_rekeys WHERE device_id = ?').run(deviceId);
  return 'ok';
}
