/**
 * Rooms and the boxes in them - the operator's side of the building.
 *
 * "User" is not a person here. A guest never signs in, never picks a
 * password, and is gone in three days; what persists is the room and the box
 * screwed to the wall behind its television. So the unit of management is the
 * room, and everything an operator does - who sees which channels, who may
 * unlock the restricted section, whose screen says "welcome" - hangs off it.
 *
 * Three separate things decide what a given television shows, and keeping
 * them separate is what makes the building manageable:
 *
 *   1. the line      - the XUI account the box streams through. It decides
 *                      the *catalogue*: bind two floors to two different
 *                      lines and they get two different channel lists.
 *   2. the room      - which box, where, and who is staying in it. It decides
 *                      the *dressing*: the name on the welcome card, the
 *                      notices, where a room-service order comes from.
 *   3. entitlements  - the restricted section, per box, off by default.
 *
 * Check-out is the one operation that touches all three, and the reason this
 * module exists rather than a handful of loose UPDATEs: the next guest is a
 * different person, so the name goes, and so does anything the last guest was
 * allowed to unlock.
 */
import { db, now } from './db.js';
import * as adult from './adult.js';
import * as properties from './properties.js';

/** Trim, cap, and turn empty into null - the shape every text field wants. */
const text = (v, max = 80) => {
  const s = String(v ?? '').trim().slice(0, max);
  return s || null;
};

/**
 * 这台盒子现在归哪家，没归就是 null。
 *
 * 看着多余，其实是一个踩过的坑：SQLite 给回来的是整数或者 null，而
 * `Number(null)` 是 **0**，`Number.isInteger(0)` 又是 true —— 于是「还没分给
 * 任何酒店」会被当成「归 id 为 0 的那家酒店」一路放行，房间号写进一家不存在
 * 的店底下，后台还回一句「已保存」。所以这里绝不能用 Number() 兜。
 */
function ownerOf(deviceId) {
  return db.prepare('SELECT property_id FROM devices WHERE device_id = ?').get(deviceId)
    ?.property_id ?? null;
}

/**
 * 把某一家的线路交给这台盒子，规矩和 `devices.hello()` 一致。
 *
 * 拿不到线路时（`propertyId` 为 null = 退回无主池，或者这家根本还没配线路），
 * **旧东家的线路一定要收回** —— 留着就是让这台电视继续放上一家的片单，
 * 而那是客人唯一看得见的东西。收回之后它得重新配对，所以要有配对码。
 *
 * 已经在显示配对码的就沿用那一个：电视上那串数字不该因为后台点了一下就变，
 * 不然对着屏幕抄号码的人手里的号码就作废了。
 */
function handOverLine(deviceId, propertyId) {
  const line = propertyId == null ? null : properties.lineFor(properties.find(propertyId));
  if (line?.username) {
    db.prepare('UPDATE devices SET line_user = ?, line_pass = ?, code = NULL WHERE device_id = ?')
      .run(line.username, line.password, deviceId);
    return true;
  }
  const keep = db.prepare('SELECT code FROM devices WHERE device_id = ?').get(deviceId)?.code;
  db.prepare('UPDATE devices SET line_user = NULL, line_pass = NULL, code = ? WHERE device_id = ?')
    .run(keep ?? freshCode(), deviceId);
  return false;
}

const getRoom = db.prepare('SELECT * FROM rooms WHERE property_id = ? AND room_id = ?');

/**
 * Make sure a room row exists before a box is pointed at it.
 *
 * Assigning box to room 301 should not fail because nobody typed 301 into a
 * separate form first; the room number *is* the room.
 */
export function ensureRoom(pid, roomId) {
  const id = text(roomId, 32);
  if (!id) return null;
  if (!getRoom.get(pid, id)) {
    db.prepare(
      'INSERT INTO rooms (property_id, room_id, building, floor, guest_name, checked_in, updated_at) VALUES (?, ?, NULL, NULL, NULL, 0, ?)',
    ).run(pid, id, now());
  }
  return id;
}

/**
 * Every box, with the room it sits in.
 *
 * `lastSeen` is the last time the box *booted*, not a heartbeat - the launcher
 * calls hello once at startup and then never again. A television that has been
 * on all week reports the day it was switched on, and the console says
 * "最后开机" rather than "在线" because of it.
 */
export function roster(pid = null, { includeUnassigned = false } = {}) {
  /*
   * pid 为 null = 看全部（平台管理员没选具体哪家时）。
   * 给了 pid 就只看这一家 —— 酒店管理员永远如此。
   *
   * `includeUnassigned` 是给平台管理员的：选中某一家时，除了这家的盒子，
   * 还要能看到**还没分给任何人的新盒子**，因为「把这台划给这家」这个动作
   * 就在这张表上做。酒店管理员拿不到这个开关，别家的和无主的都看不见。
   */
  const where =
    pid == null
      ? ''
      : includeUnassigned
        ? 'WHERE (d.property_id = ? OR d.property_id IS NULL)'
        : 'WHERE d.property_id = ?';
  const devices = db
    .prepare(`
      SELECT d.device_id, d.mac, d.code, d.room_id, d.line_user, d.label,
             d.last_seen, d.created_at, d.adult_allowed, d.content_until,
             d.property_id, p.name AS property_name,
             r.building, r.floor, r.guest_name, r.checked_in
        FROM devices d
        LEFT JOIN properties p ON p.id = d.property_id
        LEFT JOIN rooms r ON r.room_id = d.room_id AND r.property_id = d.property_id
       ${where}
       ORDER BY d.property_id, d.room_id IS NULL, d.room_id, d.created_at
    `)
    .all(...(pid == null ? [] : [pid]))
    .map((d) => ({
      deviceId: d.device_id,
      propertyId: d.property_id,
      propertyName: d.property_name,
      mac: d.mac,
      // Only meaningful while unbound; a paired box has no code to show.
      code: d.line_user ? null : d.code,
      roomId: d.room_id,
      label: d.label,
      line: d.line_user,
      bound: Boolean(d.line_user),
      lastSeen: d.last_seen,
      createdAt: d.created_at,
      adultAllowed: Boolean(d.adult_allowed),
      contentUntil: d.content_until || null,
      building: d.building,
      floor: d.floor,
      guestName: d.guest_name,
      checkedIn: Boolean(d.checked_in),
    }));

  const rooms = db
    .prepare(`
      SELECT r.*,
             (SELECT COUNT(*) FROM devices d
               WHERE d.room_id = r.room_id AND d.property_id = r.property_id) AS boxes
        FROM rooms r
       ${pid == null ? '' : 'WHERE r.property_id = ?'}
       ORDER BY r.property_id, r.room_id
    `)
    .all(...(pid == null ? [] : [pid]))
    .map((r) => ({
      propertyId: r.property_id,
      roomId: r.room_id,
      building: r.building,
      floor: r.floor,
      guestName: r.guest_name,
      checkedIn: Boolean(r.checked_in),
      boxes: r.boxes,
      updatedAt: r.updated_at,
    }));

  return { devices, rooms };
}

/**
 * Edit one box.
 *
 * Only the fields present in `patch` are touched, so the console can save a
 * room number without clearing a label. A line is user *and* password or
 * neither: half a credential authenticates against nothing, and storing it
 * would leave a box that looks configured and plays nothing.
 *
 * `adoptInto` 是平台管理员当前正在管的那一家。给一台还没主的盒子填房间号时，
 * 它同时就是「把这台划给这家」—— 见下面那段注释。酒店管理员用不到（他们的
 * `pid` 已经把范围锁死了），传了也不会生效。
 *
 * 返回 `{ device, adoptedInto }`，不是光一行设备：调用方要知道这一次有没有
 * 顺带认领，好把话说清楚。
 */
export function saveDevice(pid, deviceId, patch, { adoptInto = null } = {}) {
  const dev = db
    .prepare(
      pid == null
        ? 'SELECT * FROM devices WHERE device_id = ?'
        : 'SELECT * FROM devices WHERE device_id = ? AND property_id = ?',
    )
    .get(...(pid == null ? [String(deviceId)] : [String(deviceId), pid]));
  if (!dev) return null;

  /*
   * 换一家酒店 —— 发货层面的事，只有平台管理员能做（酒店管理员连别家的存在都看不见）。
   *
   * 四件事必须一起发生，漏一件就是一台「看着在新店、其实还在旧店」的电视：
   *   **房间号清掉** —— 房间号是每家自己编的，A 店的 101 和 B 店的 101 不是同一个房间；
   *   **线路换成新东家的** —— 片单是客人唯一看得见的东西，不换等于没换店；
   *   **成人授权收回** —— 和退房同一个道理，上一家放开过的不留给下一家；
   *   **`propertyId: null` 就是退回无主池** —— 线路收走、重新显示配对码。
   */
  let moved = null;
  if ('propertyId' in patch && pid == null) {
    const target = patch.propertyId == null ? null : Number(patch.propertyId);
    if (target !== ownerOf(dev.device_id)) {
      db.prepare('UPDATE devices SET property_id = ?, room_id = NULL WHERE device_id = ?')
        .run(target, dev.device_id);
      handOverLine(dev.device_id, target);
      adult.setDeviceAllowed(dev.device_id, false);
      moved = { propertyId: target, name: target == null ? null : (properties.find(target)?.name ?? null) };
    }
  }

  /*
   * 平台管理员在某一家的表里，给一台还没主的盒子填房间号 ——
   * 这个动作本身就是「把这台划给这家」。这张表是唯一能做这件事的地方：
   * roster 之所以把无主的盒子也一并列出来，就是为了这一下（见 roster 注释）。
   *
   * 线路也一起发下去，和 devices.hello() 那段一样。不发的话，刚点完保存
   * 这一行还会写着「待配对 + 配对码」，要等盒子下次开机才变 —— 没人能从
   * 「还没配对」里读出「成了，去电视上按一下刷新」。
   */
  let adopted = null;
  if (pid == null && adoptInto != null && ownerOf(dev.device_id) == null) {
    db.prepare('UPDATE devices SET property_id = ? WHERE device_id = ?')
      .run(adoptInto, dev.device_id);
    handOverLine(dev.device_id, adoptInto);
    adopted = adoptInto;
  }

  const sets = [];
  const args = [];

  if ('roomId' in patch) {
    const owner = pid ?? ownerOf(dev.device_id);
    if (!Number.isInteger(owner)) {
      throw Object.assign(new Error('这台盒子还没分给任何酒店，先分配再填房间号'), {
        statusCode: 400,
      });
    }
    const id = ensureRoom(owner, patch.roomId);
    sets.push('room_id = ?');
    args.push(id);
  }
  if ('label' in patch) {
    sets.push('label = ?');
    args.push(text(patch.label));
  }
  if ('lineUser' in patch || 'linePass' in patch) {
    const user = text(patch.lineUser, 64);
    const pass = text(patch.linePass, 128);
    if (user && !pass) {
      throw Object.assign(new Error('换线路要同时填账号和密码'), { statusCode: 400 });
    }
    // Clearing the line un-pairs the box. It needs a code to be paired again,
    // and the old one was thrown away when it was bound.
    sets.push('line_user = ?', 'line_pass = ?', 'code = ?');
    args.push(user, user ? pass : null, user ? null : freshCode());
  }

  if (sets.length) {
    db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE device_id = ?`).run(
      ...args,
      dev.device_id,
    );
  }

  if ('adultAllowed' in patch) adult.setDeviceAllowed(dev.device_id, Boolean(patch.adultAllowed));

  return {
    device: db.prepare('SELECT * FROM devices WHERE device_id = ?').get(dev.device_id),
    // 有值 = 这一次顺带把无主的盒子划给了这家，控制台要说出来。
    adoptedInto: adopted == null ? null : (properties.find(adopted)?.name ?? null),
    // 有值 = 这一次换了东家。`name` 为 null 表示退回了无主池。
    moved,
  };
}

/** A code nobody else holds. Mirrors devices.js so an un-paired box can pair. */
function freshCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let c = '';
    for (let i = 0; i < 6; i++) c += Math.floor(Math.random() * 10);
    if (!db.prepare('SELECT 1 FROM devices WHERE code = ?').get(c)) return c;
  }
  throw new Error('could not allocate a pairing code');
}

/**
 * Forget a box.
 *
 * For a television that was replaced or a test device, not for a box still on
 * the wall: the next time that one boots it registers again as new, with a
 * fresh pairing code and no room.
 */
export function removeDevice(pid, deviceId) {
  const info = db
    .prepare(
      pid == null
        ? 'DELETE FROM devices WHERE device_id = ?'
        : 'DELETE FROM devices WHERE device_id = ? AND property_id = ?',
    )
    .run(...(pid == null ? [String(deviceId)] : [String(deviceId), pid]));
  return info.changes > 0;
}

/** Create or edit a room. Returns the room as the console lists it. */
export function saveRoom(pid, roomId, patch = {}) {
  const id = ensureRoom(pid, roomId);
  if (!id) throw Object.assign(new Error('房间号不能为空'), { statusCode: 400 });

  const sets = [];
  const args = [];
  for (const [field, column, max] of [
    ['building', 'building', 40],
    ['floor', 'floor', 16],
    ['guestName', 'guest_name', 80],
  ]) {
    if (field in patch) {
      sets.push(`${column} = ?`);
      args.push(text(patch[field], max));
    }
  }
  if ('checkedIn' in patch) {
    sets.push('checked_in = ?');
    args.push(patch.checkedIn ? 1 : 0);
  }

  sets.push('updated_at = ?');
  args.push(now());
  db.prepare(`UPDATE rooms SET ${sets.join(', ')} WHERE property_id = ? AND room_id = ?`).run(
    ...args,
    pid,
    id,
  );
  return getRoom.get(pid, id);
}

/**
 * Delete a room.
 *
 * Refused while a box still points at it: the box would keep a room_id that
 * resolves to nothing, and its welcome card, its notices and its room-service
 * orders would all quietly lose their address. Move the boxes first.
 */
export function removeRoom(pid, roomId) {
  const id = text(roomId, 32);
  if (!id || !getRoom.get(pid, id)) return { ok: false, reason: '房间不存在' };

  const boxes = db
    .prepare('SELECT COUNT(*) n FROM devices WHERE room_id = ? AND property_id = ?')
    .get(id, pid).n;
  if (boxes) return { ok: false, reason: `还有 ${boxes} 台盒子在这个房间，先把它们挪走` };

  db.prepare('DELETE FROM rooms WHERE property_id = ? AND room_id = ?').run(pid, id);
  db.prepare('DELETE FROM notices WHERE property_id = ? AND room_id = ?').run(pid, id);
  return { ok: true };
}

/** Someone moved in. The name is what the welcome card greets. */
export function checkIn(pid, roomId, guestName) {
  return saveRoom(pid, roomId, { guestName, checkedIn: true });
}

/**
 * Someone moved out.
 *
 * The name goes, and so does every entitlement granted to the boxes in that
 * room. A guest who was allowed the restricted section on Tuesday must not
 * hand that over to whoever checks in on Wednesday, and nobody at a front desk
 * is going to remember to revoke it by hand.
 */
export function checkOut(pid, roomId) {
  const id = text(roomId, 32);
  if (!id || !getRoom.get(pid, id)) return null;

  // 只收这家酒店这个房间的盒子。少了 property_id 这个条件，
  // A 店给 301 退房会把 B 店 301 的授权一起收掉。
  const boxes = db
    .prepare('SELECT device_id FROM devices WHERE room_id = ? AND property_id = ?')
    .all(id, pid);
  for (const b of boxes) adult.setDeviceAllowed(b.device_id, false);

  return saveRoom(pid, id, { guestName: null, checkedIn: false });
}
