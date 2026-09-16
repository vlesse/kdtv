/**
 * 收款。
 *
 * 这里收三种钱，走同一条管子：
 *
 *   service   客人在电视上点的客房服务
 *   unlock    客人自己买的观看权（酒店不付费时才会出现）
 *   property  酒店按期付给我们的服务费
 *
 * 三种只是「付完之后做什么」不一样，下单、出码、回调、查单、对账完全共用。
 * 把它们拆成三套的诱惑很大，但那样意味着同一个回调校验写三遍，
 * 而回调校验写错一次就是「谁都能把订单标成已付款」。
 *
 * 钱这件事有两条铁律，这份代码围着它们转：
 *
 *  1. **回调会丢。** 网络抖动、我们正好在重启、上游根本没发 —— 所以除了等
 *     回调，还要自己定期去问（reconcile）。只有一条路的话，客人付了钱什么
 *     都不会发生，而且谁都不知道。
 *  2. **同一笔钱只能生效一次。** 回调可能重发，查单和回调可能同时到。
 *     所以「改状态」和「发货」必须在一个事务里，且以状态从 pending 变成
 *     paid 的那一次为准。
 */
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { db, now, PLATFORM } from './db.js';
import { getSetting, setSetting } from './settings.js';
import * as jeepay from './jeepay.js';
import { config } from './config.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS pay_orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no      TEXT NOT NULL UNIQUE,
    kind          TEXT NOT NULL,
    ref_id        TEXT,
    device_id     TEXT,
    room_id       TEXT,
    amount_cents  INTEGER NOT NULL,
    currency      TEXT NOT NULL,
    way_code      TEXT NOT NULL,
    subject       TEXT NOT NULL,
    state         TEXT NOT NULL DEFAULT 'pending',
    pay_order_id  TEXT,
    code_url      TEXT,
    pay_url       TEXT,
    note          TEXT,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    paid_at       INTEGER,
    property_id   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pay_state ON pay_orders(state, expires_at);
  CREATE INDEX IF NOT EXISTS idx_pay_device ON pay_orders(device_id, created_at);
`);

/**
 * 币种的最小单位有几位小数。
 *
 * Jeepay 的金额单位是「分」——- 也就是最小单位。人民币 1 元 = 100，
 * 但柬埔寨瑞尔和印尼盾在实际使用中没有小数位，1 KHR 就是 1。
 * 统一乘 100 的话，柬埔寨的每一笔都会变成一百倍。
 */
const MINOR = { CNY: 2, USD: 2, EUR: 2, THB: 2, MYR: 2, SGD: 2, HKD: 2, KHR: 0, IDR: 0, VND: 0, JPY: 0, KRW: 0 };

export const minorExp = (cur) => MINOR[String(cur || 'CNY').toUpperCase()] ?? 2;

/** 显示金额（元/美元/瑞尔）→ 最小单位整数。 */
export const toMinor = (amount, cur) => Math.round(Number(amount) * 10 ** minorExp(cur));

/** 最小单位整数 → 显示金额。 */
export const fromMinor = (cents, cur) => Number(cents) / 10 ** minorExp(cur);

export function formatMoney(cents, cur) {
  const e = minorExp(cur);
  return `${fromMinor(cents, cur).toFixed(e)} ${String(cur || '').toUpperCase()}`;
}

/*
 * 已经在跑的库里 pay_orders 是单租户时建的，补上归属列。
 *
 * 顺序要紧：上面那段 `CREATE TABLE IF NOT EXISTS` 对已存在的表什么都不做，
 * 所以老库里这一列还不存在。带 property_id 的索引必须**等这个 ALTER 跑完**
 * 才能建 —— 建在前面的话，整个 db.exec 会在启动时报
 * 「no such column: property_id」，服务直接起不来。上线时就是这么炸的。
 */
{
  const have = db.prepare('PRAGMA table_info(pay_orders)').all();
  if (!have.some((c) => c.name === 'property_id')) {
    db.exec('ALTER TABLE pay_orders ADD COLUMN property_id INTEGER');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_pay_prop ON pay_orders(property_id, created_at)');
}

// ------------------------------------------------------------------ 通道配置

const KEYS = {
  gatewayUrl: 'pay.jeepay.gateway',
  mchNo: 'pay.jeepay.mchNo',
  appId: 'pay.jeepay.appId',
  appSecret: 'pay.jeepay.appSecret',
  wayCode: 'pay.jeepay.wayCode',
  currency: 'pay.currency',
  enabled: 'pay.enabled',
};

/**
 * 钱进谁的口袋，是按「这是什么钱」定的，不是按「谁点的按钮」。
 *
 *   service   客人点餐   → **这家酒店自己的商户**。餐是酒店做的，钱是酒店的，
 *                          我们不经手；不用对账分账，也不碰别人的资金。
 *   unlock    客人买观看权 → 平台商户。片库是我们供的。
 *   property  酒店交服务费 → 平台商户。这是付给我们的钱。
 *
 * 所以通道有两套配置，用 property_id 分开存：0 号是平台自己的，
 * 1 以上是各家酒店的。传错一个 id，就是把 A 店的餐费打进 B 店的账户 ——
 * 这也是为什么下面每个函数都要求显式给出 scope，没有默认值。
 */
export const scopeOf = (kind, propertyId) =>
  kind === 'service' ? Number(propertyId) : PLATFORM;

export function credentials(scope) {
  return {
    gatewayUrl: getSetting(scope, KEYS.gatewayUrl) || '',
    mchNo: getSetting(scope, KEYS.mchNo) || '',
    appId: getSetting(scope, KEYS.appId) || '',
    appSecret: getSetting(scope, KEYS.appSecret) || '',
  };
}

export const wayCode = (scope) => getSetting(scope, KEYS.wayCode) || 'ALI_QR';
export const currency = (scope) => (getSetting(scope, KEYS.currency) || 'CNY').toUpperCase();

/** 配齐了且开着，才算能收款。少一项都当没配。 */
export function payEnabled(scope) {
  const c = credentials(scope);
  return (
    getSetting(scope, KEYS.enabled) === '1' &&
    Boolean(c.gatewayUrl && c.mchNo && c.appId && c.appSecret)
  );
}

/**
 * 通道状态，给后台看。
 *
 * **密钥永远不回传**，只回「配没配」。这个后台开在公网域名上，
 * 一个从来不发出去的值，没人能从别人忘了关的屏幕上抄走。
 */
export function channelState(scope) {
  const c = credentials(scope);
  return {
    scope,
    enabled: getSetting(scope, KEYS.enabled) === '1',
    ready: payEnabled(scope),
    gatewayUrl: c.gatewayUrl,
    mchNo: c.mchNo,
    appId: c.appId,
    secretSet: Boolean(c.appSecret),
    wayCode: wayCode(scope),
    currency: currency(scope),
  };
}

export function saveChannel(scope, patch) {
  for (const field of ['gatewayUrl', 'mchNo', 'appId', 'appSecret', 'wayCode']) {
    if (field in patch) {
      const v = String(patch[field] ?? '').trim();
      // 密钥留空 = 不改，不是清空。后台表单永远回显不了它，
      // 保存别的字段时留空的密钥不能把已配好的抹掉。
      if (field === 'appSecret' && !v) continue;
      setSetting(scope, KEYS[field], v);
    }
  }
  if ('currency' in patch) {
    const cur = String(patch.currency ?? '').trim().toUpperCase();
    if (cur && !/^[A-Z]{3}$/.test(cur)) throw Object.assign(new Error('币种要写三位字母，比如 USD / KHR / CNY'), { statusCode: 400 });
    if (cur) setSetting(scope, KEYS.currency, cur);
  }
  if ('enabled' in patch) {
    if (patch.enabled && !payEnabled(scope) && !credentials(scope).appSecret) {
      throw Object.assign(new Error('先把网关地址、商户号、应用 ID、应用密钥填全再开'), { statusCode: 400 });
    }
    setSetting(scope, KEYS.enabled, patch.enabled ? '1' : '0');
  }
  return channelState(scope);
}

export const probeChannel = (scope) => jeepay.probe(credentials(scope));

// ------------------------------------------------------------------ 下单

/** 订单号。带时间前缀便于人工对账，尾巴是随机的，避免同一毫秒撞号。 */
function freshOrderNo(kind) {
  const p = { service: 'SV', unlock: 'UL', property: 'PR' }[kind] ?? 'XX';
  const d = new Date();
  const stamp =
    d.getUTCFullYear().toString().slice(2) +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0') +
    String(d.getUTCHours()).padStart(2, '0') +
    String(d.getUTCMinutes()).padStart(2, '0');
  return `${p}${stamp}${randomBytes(4).toString('hex').toUpperCase()}`;
}

/** 二维码给客人的时间。太短会让人手忙脚乱，太长会占着一笔上游订单。 */
const TTL_SECONDS = 15 * 60;

const insert = db.prepare(`
  INSERT INTO pay_orders
    (order_no, kind, ref_id, property_id, device_id, room_id, amount_cents, currency, way_code,
     subject, state, pay_order_id, code_url, pay_url, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
`);

export const findOrder = (orderNo) =>
  db.prepare('SELECT * FROM pay_orders WHERE order_no = ?').get(String(orderNo)) ?? null;

/**
 * 建一笔收款，拿回二维码。
 *
 * 先问网关再落库：网关拒了就什么都没发生，不会留下一堆永远付不掉的空单。
 */
export async function createOrder({ kind, refId, propertyId, deviceId, roomId, amountCents, subject, clientIp }) {
  // 这一笔该进谁的账户，只由 kind 和 propertyId 决定，见 scopeOf。
  const scope = scopeOf(kind, propertyId);
  if (kind === 'service' && !Number.isInteger(scope)) {
    throw Object.assign(new Error('点餐收款必须指明是哪家酒店'), { statusCode: 400 });
  }
  if (!payEnabled(scope)) throw Object.assign(new Error('还没配收款通道'), { statusCode: 503 });
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw Object.assign(new Error('金额不对'), { statusCode: 400 });
  }

  const base = config.publicBaseUrl;
  if (!base) {
    // 没有这个地址，网关回调打不回来 —— 钱收了订单不变已支付。
    // 与其收了钱不发货，不如现在就拒绝。
    throw Object.assign(
      new Error('服务器没配 PUBLIC_BASE_URL，支付回调会打不回来，先配好再收款'),
      { statusCode: 503 },
    );
  }

  const orderNo = freshOrderNo(kind);
  const cur = currency(scope);
  const res = await jeepay.createPayment(credentials(scope), {
    orderNo,
    amountCents,
    currency: cur,
    wayCode: wayCode(scope),
    subject,
    notifyUrl: `${base}/api/pay/notify/jeepay`,
    clientIp,
  });

  const t = now();
  insert.run(
    orderNo, kind, refId == null ? null : String(refId),
    propertyId == null ? null : Number(propertyId), deviceId ?? null, roomId ?? null,
    amountCents, cur, wayCode(scope), subject,
    res.payOrderId ?? null, res.codeUrl ?? null, res.payUrl ?? null,
    t, t + TTL_SECONDS,
  );

  const out = publicOrder(findOrder(orderNo));
  out.qrSvg = await qrSvg(res.codeUrl || res.payUrl);
  return out;
}

/** 给一笔已有的单补上二维码（轮询、后台重新打开时用）。 */
export async function withQr(row) {
  const out = publicOrder(row);
  if (out) out.qrSvg = await qrSvg(row.code_url || row.pay_url);
  return out;
}

/**
 * 二维码画成 SVG，在服务端画。
 *
 * 不是为了省一个前端依赖 —— 是因为另一端是机顶盒里的旧 WebView。
 * 在那上面用 canvas 画码，慢、模糊、而且 4K 屏上会糊成一团；
 * SVG 是矢量的，放多大都是清的，而且到了电视上只是一段标记，不用跑任何代码。
 */
async function qrSvg(text) {
  if (!text) return null;
  try {
    return await QRCode.toString(String(text), {
      type: 'svg',
      margin: 1,
      // 二维码印在电视上，人拿手机隔一米多扫。容错高一点，屏幕反光、
      // 拍虚一点也还能认出来。
      errorCorrectionLevel: 'Q',
    });
  } catch {
    // 画不出来不该让付款流程断掉：下面还有 codeUrl 原文可以显示。
    return null;
  }
}

/** 一笔收款，电视端能看到的样子。 */
export function publicOrder(row) {
  if (!row) return null;
  return {
    orderNo: row.order_no,
    kind: row.kind,
    state: row.state,
    amount: fromMinor(row.amount_cents, row.currency),
    amountText: formatMoney(row.amount_cents, row.currency),
    currency: row.currency,
    subject: row.subject,
    codeUrl: row.code_url,
    payUrl: row.pay_url,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
  };
}

// ------------------------------------------------------------------ 收钱之后

/**
 * 付款生效时该做的事，按种类分。
 *
 * 只在 markPaid 的事务里调用，所以这里不需要再考虑重复执行。
 */
function applyEffect(row) {
  if (row.kind === 'service' && row.ref_id) {
    db.prepare("UPDATE orders SET status = 'paid' WHERE id = ? AND status = 'new'").run(Number(row.ref_id));
    return;
  }

  if (row.kind === 'unlock' && row.device_id) {
    // 续期而不是覆盖：还没过期的时候又买一次，应该往后接，不是从头算。
    const dev = db.prepare('SELECT content_until FROM devices WHERE device_id = ?').get(row.device_id);
    const from = Math.max(Number(dev?.content_until ?? 0), now());
    const days = Number(row.ref_id) || 1;
    db.prepare('UPDATE devices SET content_until = ? WHERE device_id = ?')
      .run(from + days * 86400, row.device_id);
    return;
  }

  if (row.kind === 'property' && row.property_id != null) {
    const pid = Number(row.property_id);
    const from = Math.max(Number(getSetting(pid, 'billing.paidUntil') ?? 0), now());
    const days = Number(row.ref_id) || 30;
    setSetting(pid, 'billing.paidUntil', String(from + days * 86400));
  }
}

/**
 * 把一笔标成已付款，并且发货。
 *
 * 回调和查单都会走到这里，可能同时。状态从 pending 变成 paid 的
 * UPDATE 自带 `WHERE state = 'pending'`，改到 0 行就说明别人已经处理过了，
 * 直接返回 —— 这是整个支付里唯一防重复发货的地方。
 */
export function markPaid(orderNo, { upstreamNo, amountCents } = {}) {
  const row = findOrder(orderNo);
  if (!row) return { ok: false, reason: '没有这笔单' };

  /*
   * 这里**故意不写** `if (row.state === 'paid') return`。
   *
   * 那样看着更直白，但它会变成第二道防线，而两道防线里只有下面那条
   * UPDATE ... WHERE state != 'paid' 在并发下是真的 —— 回调和对账同时到达
   * 时，两个调用都会在各自的 findOrder 里读到 pending，早退那条拦不住。
   * 更糟的是它会让「去掉 UPDATE 上的 WHERE」这种改动测不出来：我第一版就是
   * 这么写的，自检把防重复发货测成了绿的。
   *
   * 所以判断「这笔是不是已经处理过」只有一个依据：UPDATE 改到了几行。
   */

  // 金额对不上不发货。上游金额和我们记的不一致，只可能是配置错了或者
  // 有人在中间改过，两种都不该按原样发货。
  if (amountCents != null && Number(amountCents) !== row.amount_cents) {
    db.prepare('UPDATE pay_orders SET note = ? WHERE order_no = ?')
      .run(`金额不符：网关 ${amountCents}，本地 ${row.amount_cents}`, orderNo);
    return { ok: false, reason: `金额不符（网关 ${amountCents} / 本地 ${row.amount_cents}）` };
  }

  let changed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    changed = db
      .prepare("UPDATE pay_orders SET state = 'paid', paid_at = ?, pay_order_id = COALESCE(?, pay_order_id) WHERE order_no = ? AND state != 'paid'")
      .run(now(), upstreamNo ?? null, orderNo).changes;
    if (changed) applyEffect(findOrder(orderNo));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { ok: true, already: changed === 0, row: findOrder(orderNo) };
}

/** 用当前配好的密钥解析一个回调。 */
/**
 * 用哪把密钥去验这个回调，取决于这笔单是谁的钱。
 *
 * 平台和每家酒店各有各的 appSecret。拿平台的密钥去验一笔酒店餐费的回调，
 * 永远验不过 —— 客人付了钱，订单一直是待付款。所以先按单号找到这笔单，
 * 再用它对应的通道去验。
 */
export function parseNotifyParams(params) {
  const row = findOrder(params?.mchOrderNo);
  if (!row) return { valid: false, success: false, reason: '没有这笔单' };
  return jeepay.parseNotify(params, credentials(scopeOf(row.kind, row.property_id)));
}

// ------------------------------------------------------------------ 对账

/**
 * 主动去问网关：还没付的那些，到底怎么样了。
 *
 * 这是回调之外的第二条路，不是冗余 —— 回调丢了的时候它是唯一一条。
 * 顺手把过期的关掉，免得电视上一直转圈。
 */
export async function reconcile(log) {

  /*
   * 过期的单子也要继续问，问满 24 小时。
   *
   * 扫码付款经常是这样：客人扫了码去找手机银行，回来时我们这边的 15 分钟
   * 已经到了，钱几分钟后才真正到账。只查 pending 的话这笔钱就被静默吞掉了 ——
   * 客人付了，系统当没发生。
   */
  const pending = db
    .prepare(`
      SELECT * FROM pay_orders
       WHERE state = 'pending'
          OR (state = 'expired' AND created_at > ?)
       ORDER BY created_at LIMIT 50
    `)
    .all(now() - 86400);

  let paid = 0;
  let expired = 0;

  for (const row of pending) {
    try {
      const scope = scopeOf(row.kind, row.property_id);
      if (!payEnabled(scope)) continue; // 这家的通道关了，问也白问
      const q = await jeepay.queryOrder(credentials(scope), {
        payOrderId: row.pay_order_id,
        mchOrderNo: row.order_no,
      });
      if (q.paid) {
        // 已经过期的那批不自动发货 —— 见 handleLatePayment。
        if (row.state === 'expired') {
          handleLatePayment(row, log);
          paid++;
          continue;
        }
        const r = markPaid(row.order_no, { upstreamNo: q.payOrderId, amountCents: q.amountCents });
        if (r.ok && !r.already) {
          paid++;
          log?.warn({ orderNo: row.order_no }, '对账补回了一笔回调没送到的付款');
        }
        continue;
      }
      // 过期只关我们这边的单。网关那笔自己会关，而且钱要是**之后**才到，
      // 下一轮对账还会看见它并照常入账 —— 迟到的付款不能被静默吞掉。
      if (row.state === 'pending' && row.expires_at < now()) {
        db.prepare("UPDATE pay_orders SET state = 'expired' WHERE order_no = ? AND state = 'pending'")
          .run(row.order_no);
        expired++;
      }
    } catch (err) {
      log?.warn({ orderNo: row.order_no, err: err.message }, '查单失败');
    }
  }

  return { checked: pending.length, paid, expired };
}

/**
 * 迟到的付款。
 *
 * 单子已经过期关掉了，钱才到。订单不自动生效，但必须吼出来 ——
 * 静默吞掉就是客人付了钱什么都没有，而且没人知道。
 */
export function handleLatePayment(row, log) {
  db.prepare("UPDATE pay_orders SET state = 'paid', paid_at = ?, note = ? WHERE order_no = ?")
    .run(now(), '迟到的付款：单子已过期，未自动发货，需人工处理', row.order_no);
  log?.error({ orderNo: row.order_no, amount: row.amount_cents }, '收到一笔迟到的付款，需要人工处理');
}
