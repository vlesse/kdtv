/**
 * 客房服务：菜单和订单，运营那一面。
 *
 * 之前这块只有一半：菜单是开机时种进去的印尼宿舍菜（Nasi Goreng、Es Teh
 * Manis、单位 IDR），后台没有地方改；客人下的单进了 orders 表，然后**没有
 * 任何地方能看到它** —— 前台不知道有人点了东西。等于这个功能不存在。
 *
 * 所以这里做两件事：让菜单能改，让订单能看见。
 */
import { db, now } from './db.js';
import * as pay from './pay.js';

const LANGS = ['en', 'zh', 'id', 'km'];

const text = (v, max = 120) => {
  const s = String(v ?? '').trim().slice(0, max);
  return s || null;
};

/** 菜单，后台看的样子（含下架的）。 */
export function menu(pid) {
  return db
    .prepare('SELECT * FROM service_items WHERE property_id = ? ORDER BY category, sort_order, id')
    .all(pid)
    .map((r) => ({
      id: r.id,
      category: r.category,
      name: { en: r.name_en, zh: r.name_zh, id: r.name_id, km: r.name_km },
      price: r.price,
      currency: r.currency,
      image: r.image,
      available: Boolean(r.available),
      sortOrder: r.sort_order,
    }));
}

/**
 * 新增或修改一个菜品。
 *
 * 英文名是必填的：它是订单里落下来的那个名字，也是四种语言里唯一
 * 保证有值的。缺了它，前台收到的单子上会是一行空白。
 */
export function saveItem(pid, patch) {
  const id = patch?.id == null ? null : Number(patch.id);
  const nameEn = text(patch?.name?.en ?? patch?.nameEn);
  const category = text(patch?.category, 40);

  if (!id) {
    if (!nameEn) throw Object.assign(new Error('英文名必填 —— 订单上记的就是它'), { statusCode: 400 });
    if (!category) throw Object.assign(new Error('分类必填'), { statusCode: 400 });
  }

  const price = patch?.price == null ? null : Number(patch.price);
  if (price != null && (!Number.isFinite(price) || price < 0)) {
    throw Object.assign(new Error('价格不能是负数'), { statusCode: 400 });
  }

  const cur = patch?.currency ? String(patch.currency).trim().toUpperCase() : null;
  if (cur && !/^[A-Z]{3}$/.test(cur)) {
    throw Object.assign(new Error('币种要写三位字母，比如 USD / KHR'), { statusCode: 400 });
  }

  if (!id) {
    const info = db
      .prepare(`
        INSERT INTO service_items
          (property_id, category, name_en, name_zh, name_id, name_km, price, currency, image, available, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        pid,
        category,
        nameEn,
        text(patch?.name?.zh),
        text(patch?.name?.id),
        text(patch?.name?.km),
        price ?? 0,
        cur ?? pay.currency(pid),
        text(patch?.image, 300),
        patch?.available === false ? 0 : 1,
        Number(patch?.sortOrder) || 0,
      );
    return Number(info.lastInsertRowid);
  }

  const sets = [];
  const args = [];
  const put = (col, val) => {
    sets.push(`${col} = ?`);
    args.push(val);
  };

  if (category !== null || 'category' in (patch ?? {})) put('category', category);
  if ('name' in (patch ?? {}) || 'nameEn' in (patch ?? {})) {
    if (nameEn) put('name_en', nameEn);
    for (const l of LANGS) {
      if (l === 'en') continue;
      if (patch?.name && l in patch.name) put(`name_${l}`, text(patch.name[l]));
    }
  }
  if (price != null) put('price', price);
  if (cur) put('currency', cur);
  if ('image' in (patch ?? {})) put('image', text(patch.image, 300));
  if ('available' in (patch ?? {})) put('available', patch.available ? 1 : 0);
  if ('sortOrder' in (patch ?? {})) put('sort_order', Number(patch.sortOrder) || 0);

  if (!sets.length) return id;
  // 带上酒店：别家的菜品改不了，哪怕知道 id。
  const info = db
    .prepare(`UPDATE service_items SET ${sets.join(', ')} WHERE id = ? AND property_id = ?`)
    .run(...args, id, pid);
  return info.changes ? id : null;
}

/**
 * 删一个菜品。
 *
 * 已经下过的单里记的是当时的名字和价格（orders.items_json 是快照），
 * 所以删掉菜品不会让历史订单变成空白 —— 这正是当初存快照而不是存
 * 菜品 id 的原因。
 */
export function removeItem(pid, id) {
  return db.prepare('DELETE FROM service_items WHERE id = ? AND property_id = ?').run(Number(id), pid).changes > 0;
}

/** 把整份菜单换成另一个币种，价格不动。换场地时用。 */
export function setMenuCurrency(pid, cur) {
  const c = String(cur ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw Object.assign(new Error('币种要写三位字母'), { statusCode: 400 });
  db.prepare('UPDATE service_items SET currency = ? WHERE property_id = ?').run(c, pid);
  return c;
}

/**
 * 菜单现在用的是什么币种，跟收款通道对不对得上。
 *
 * 这不是洁癖，是一次真的会收错钱的事故：种子菜单是印尼盾（Nasi Goreng
 * 35000 IDR），收款通道配成 USD，下单时按「价格 × 收款币种」去算，
 * 结果一盘炒饭要收 **35000 美元**。
 *
 * 价格是没法自动换算的 —— 我们没有汇率，也不该替酒店定汇率。所以唯一安全的
 * 做法是：对不上就不收线上款，让单子走前台，并且在后台把这件事说清楚。
 */
export function currencyCheck(pid) {
  const used = db
    .prepare('SELECT DISTINCT currency FROM service_items WHERE available = 1 AND property_id = ?')
    .all(pid)
    .map((r) => String(r.currency || '').toUpperCase())
    .filter(Boolean);

  // 点餐收的是这家酒店自己的钱，所以比的是这家的通道币种。
  const want = pay.currency(pay.scopeOf('service', pid));
  const mixed = used.length > 1;
  const mismatch = used.length === 1 && used[0] !== want;

  return {
    menuCurrencies: used,
    payCurrency: want,
    ok: !mixed && !mismatch,
    reason: mixed
      ? `菜单里混着 ${used.join(' / ')} 几种币种，先统一`
      : mismatch
        ? `菜单是 ${used[0]}，收款通道是 ${want} —— 价格不会自动换算，先把价格改成 ${want} 再统一币种`
        : null,
  };
}

const STATUSES = ['new', 'paid', 'doing', 'done', 'cancelled'];

/**
 * 订单列表。
 *
 * 带上收款那一笔的状态：前台要回答的问题是「这单付了没有、要不要现场收钱」，
 * 而那个答案在 pay_orders 里，不在 orders 里。
 */
export function orders({ pid = null, limit = 100, status = null } = {}) {
  const where = ['1 = 1'];
  const args = [];
  // pid 为 null 是平台管理员看十家的全部；酒店管理员永远带着自己的 id。
  if (pid != null) {
    where.push('o.property_id = ?');
    args.push(pid);
  }
  if (status) {
    where.push('o.status = ?');
    args.push(status);
  }

  const rows = db
    .prepare(`
      SELECT o.*, d.label AS device_label, r.guest_name, pr.name AS property_name
        FROM orders o
        LEFT JOIN devices    d  ON d.device_id = o.device_id
        LEFT JOIN rooms      r  ON r.room_id = o.room_id AND r.property_id = o.property_id
        LEFT JOIN properties pr ON pr.id = o.property_id
       WHERE ${where.join(' AND ')}
       ORDER BY o.created_at DESC
       LIMIT ?
    `)
    .all(...args, Math.min(500, Number(limit) || 100));

  const payByRef = new Map();
  for (const p of db
    .prepare("SELECT * FROM pay_orders WHERE kind = 'service' ORDER BY created_at DESC")
    .all()) {
    // 一单可能重试过几次收款，最新的那笔才算数。
    if (!payByRef.has(p.ref_id)) payByRef.set(p.ref_id, p);
  }

  return rows.map((o) => {
    const p = payByRef.get(String(o.id)) ?? null;
    let items = [];
    try {
      items = JSON.parse(o.items_json);
    } catch {
      /* 坏掉的一行不该让整个列表打不开 */
    }
    return {
      id: o.id,
      propertyId: o.property_id,
      propertyName: o.property_name,
      roomId: o.room_id,
      guestName: o.guest_name,
      deviceLabel: o.device_label,
      deviceId: o.device_id,
      items,
      total: o.total,
      note: o.note,
      status: o.status,
      createdAt: o.created_at,
      payment: p
        ? {
            orderNo: p.order_no,
            state: p.state,
            amountText: pay.formatMoney(p.amount_cents, p.currency),
            paidAt: p.paid_at,
          }
        : null,
    };
  });
}

export function setOrderStatus(pid, id, status) {
  if (!STATUSES.includes(status)) {
    throw Object.assign(new Error(`状态只能是 ${STATUSES.join(' / ')}`), { statusCode: 400 });
  }
  return db
    .prepare(
      pid == null
        ? 'UPDATE orders SET status = ? WHERE id = ?'
        : 'UPDATE orders SET status = ? WHERE id = ? AND property_id = ?',
    )
    .run(...(pid == null ? [status, Number(id)] : [status, Number(id), pid])).changes > 0;
}

/** 前台一眼要看到的：有几单还没处理。 */
export function pendingCount(pid) {
  return db
    .prepare(
      pid == null
        ? "SELECT COUNT(*) n FROM orders WHERE status IN ('new','paid','doing')"
        : "SELECT COUNT(*) n FROM orders WHERE status IN ('new','paid','doing') AND property_id = ?",
    )
    .get(...(pid == null ? [] : [pid])).n;
}

export const statuses = STATUSES;
export const languages = LANGS;
export { now };
