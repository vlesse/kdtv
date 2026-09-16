// Device identity and pairing. The whole point of this module is that a
// guest never types a server address: the box knows only this service's URL
// (baked into the APK), announces itself, and gets everything else back.
import { db, now, PLATFORM } from './db.js';
import { getSetting } from './settings.js';
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
 * 不知道它在谁的楼里。三条线索，依次试：
 *
 *  1. **同一个 MAC 以前配过** —— 换过固件、恢复过出厂设置的老盒子，
 *     按原样接回去，不用再配一次。
 *  2. **平台设了默认酒店** —— 一次只铺一家的时候把它设上，整批盒子插电即用，
 *     现场一个字都不用输。铺完记得清掉，否则下一家的盒子会进错门。
 *  3. **都没有** —— 留在未分配池里，屏幕上显示配对码，等人在后台把它
 *     划给某一家。这是十家同时在跑时唯一安全的默认。
 */
function adopt(mac) {
  if (mac) {
    const byMac = db
      .prepare('SELECT * FROM devices WHERE mac = ? AND property_id IS NOT NULL')
      .get(mac);
    if (byMac) return { propertyId: byMac.property_id, roomId: byMac.room_id };
  }

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
    const home = adopt(mac);
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
  if (dev.property_id) {
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
