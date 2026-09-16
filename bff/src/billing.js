/**
 * 谁出钱。
 *
 * 一个开关的两面：
 *
 *   **酒店付费**（默认）—— 酒店按期付服务费，房间里的客人什么都不用付，
 *   电视上连收款的影子都看不见。这是正常状态。
 *
 *   **客人付费** —— 酒店没付（或者压根不打算付），那就让住客自己买观看权，
 *   按天算，跟着这台盒子走。
 *
 * 两者不是两套代码，是同一个判断的两个分支：`allowed()` 先看酒店付了没有，
 * 没有才去看这台盒子自己买了没有。酒店的服务费到期那一刻，电视不会黑屏，
 * 只是从「免费」变成「客人自己买」—— 这正是你要的那个行为。
 *
 * ---
 *
 * 有一条安全底线，写在 `gated()` 里，值得单独说：
 *
 *   **收不了款的时候，什么都不锁。**
 *
 * 支付通道没配好、密钥填错了、Jeepay 那台机器挂了 —— 这些时候如果照常上锁，
 * 结果是整栋楼的电视都打不开，而客人连付钱的办法都没有。一个坏掉的收银台
 * 应该让东西免费，不是让东西消失。
 */
import { db, now } from './db.js';
import { getSetting, setSetting } from './settings.js';
import * as pay from './pay.js';

const DEFAULT_GUEST_PLANS = [
  { days: 1, price: 2 },
  { days: 3, price: 5 },
  { days: 7, price: 10 },
];

const DEFAULT_PROPERTY_PLANS = [
  { days: 30, price: 200 },
  { days: 90, price: 550 },
  { days: 365, price: 2000 },
];

/** 能被收费门挡住的区域。直播不在默认名单里 —— 见 gateSections。 */
export const SECTIONS = ['live', 'vod', 'adult'];

function json(pid, key, fallback) {
  try {
    const v = JSON.parse(getSetting(pid, key) || 'null');
    return Array.isArray(v) && v.length ? v : fallback;
  } catch {
    return fallback;
  }
}

export const mode = (pid) => (getSetting(pid, 'billing.mode') === 'guest' ? 'guest' : 'property');
export const paidUntil = (pid) => Number(getSetting(pid, 'billing.paidUntil') ?? 0);
export const propertyPaid = (pid) => paidUntil(pid) > now();

/**
 * 客人付费模式下，哪些区域要买了才能看。
 *
 * 默认只挡点播。**直播默认不挡**：一台打开只有黑屏的电视，酒店第一天就会
 * 打电话来骂，而且客人根本不会想到「原来要付钱」——他只会觉得东西是坏的。
 * 直播免费，点播收费，是客人能自己看懂的分界。
 */
export const gateSections = (pid) => {
  const raw = getSetting(pid, 'billing.gateSections');
  const list = raw == null ? ['vod'] : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return list.filter((s) => SECTIONS.includes(s));
};

export const guestPlans = (pid) => json(pid, 'billing.guestPlans', DEFAULT_GUEST_PLANS);
export const propertyPlans = (pid) => json(pid, 'billing.propertyPlans', DEFAULT_PROPERTY_PLANS);

/**
 * 这个区域现在到底收不收费。
 *
 * 三个条件缺一不可：模式是客人付费、这个区域在名单里、而且**我们真的能收款**。
 * 最后一条是底线，见文件头。
 */
export function gated(pid, section) {
  if (mode(pid) !== 'guest') return false;
  if (!gateSections(pid).includes(section)) return false;
  /*
   * 客人买观看权的钱走的是**平台**通道，不是这家酒店的 —— 片库是我们供的。
   * 所以这里问的是平台通道通不通，跟这家酒店有没有配自己的点餐商户无关。
   */
  if (!pay.payEnabled(pay.scopeOf('unlock', pid))) return false;
  return true;
}

/** 这台盒子自己买的观看权还在不在。 */
export function passUntil(dev) {
  return Number(dev?.content_until ?? 0);
}
export const passActive = (dev) => passUntil(dev) > now();

/**
 * 这台盒子现在能不能看这个区域。
 *
 * 顺序就是钱的顺序：酒店付了 → 都能看；酒店没付 → 看这台自己买了没有。
 */
export function allowed(dev, section) {
  const pid = dev?.property_id;
  if (!gated(pid, section)) return true;
  if (propertyPaid(pid)) return true;
  return passActive(dev);
}

/**
 * 电视端需要知道的全部。
 *
 * 只回「能不能看」和「不能看的话多少钱」，不回酒店欠了多少钱、什么时候到期 ——
 * 那是酒店和我们之间的事，不该出现在客人的屏幕上。
 */
export function statusFor(dev) {
  const pid = dev?.property_id;
  const scope = pay.scopeOf('unlock', pid);
  const locked = SECTIONS.filter((s) => !allowed(dev, s));
  return {
    locked,
    // 有 pass 的时候告诉电视什么时候到期，好在界面上提一句。
    passUntil: passActive(dev) ? passUntil(dev) : null,
    plans: locked.length
      ? guestPlans(pid).map((p) => ({
          days: p.days,
          price: p.price,
          priceText: pay.formatMoney(pay.toMinor(p.price, pay.currency(scope)), pay.currency(scope)),
        }))
      : [],
    currency: pay.currency(scope),
  };
}

/** 后台看的那一面：含到期时间和续费方案。 */
export function adminState(pid) {
  const scope = pay.scopeOf('unlock', pid);
  return {
    mode: mode(pid),
    paidUntil: paidUntil(pid) || null,
    propertyPaid: propertyPaid(pid),
    daysLeft: propertyPaid(pid) ? Math.ceil((paidUntil(pid) - now()) / 86400) : 0,
    gateSections: gateSections(pid),
    guestPlans: guestPlans(pid),
    propertyPlans: propertyPlans(pid),
    payReady: pay.payEnabled(scope),
    currency: pay.currency(scope),
    // 有多少台盒子现在靠自己买的 pass 在看。
    passes: db
      .prepare('SELECT COUNT(*) n FROM devices WHERE property_id = ? AND content_until > ?')
      .get(pid, now()).n,
  };
}

function plansFrom(raw, label) {
  if (!Array.isArray(raw)) throw Object.assign(new Error(`${label}要是一个数组`), { statusCode: 400 });
  const out = [];
  for (const p of raw.slice(0, 12)) {
    const days = Math.trunc(Number(p?.days));
    const price = Number(p?.price);
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      throw Object.assign(new Error(`${label}：天数要在 1-3650 之间`), { statusCode: 400 });
    }
    if (!Number.isFinite(price) || price <= 0) {
      throw Object.assign(new Error(`${label}：价格要大于 0`), { statusCode: 400 });
    }
    out.push({ days, price });
  }
  if (!out.length) throw Object.assign(new Error(`${label}至少要有一档`), { statusCode: 400 });
  return out;
}

export function save(pid, patch) {
  if ('mode' in patch) {
    const m = patch.mode === 'guest' ? 'guest' : 'property';
    setSetting(pid, 'billing.mode', m);
  }
  if ('gateSections' in patch) {
    const list = (Array.isArray(patch.gateSections) ? patch.gateSections : [])
      .map(String)
      .filter((s) => SECTIONS.includes(s));
    // 空字符串是「一个都不挡」，和「没设过」不是一回事，所以存一个空标记。
    setSetting(pid, 'billing.gateSections', list.length ? list.join(',') : ' ');
  }
  if ('guestPlans' in patch) {
    setSetting(pid, 'billing.guestPlans', JSON.stringify(plansFrom(patch.guestPlans, '客人套餐')));
  }
  if ('propertyPlans' in patch) {
    setSetting(pid, 'billing.propertyPlans', JSON.stringify(plansFrom(patch.propertyPlans, '酒店套餐')));
  }
  /*
   * 手工调整到期日。
   *
   * 线下收了钱（现金、银行转账）也得有地方录进来，不能逼着所有酒店都走
   * 扫码。天数是相对的：在现有到期日上加，没到期就从今天算起。
   */
  if ('addDays' in patch) {
    const days = Math.trunc(Number(patch.addDays));
    if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 3650) {
      throw Object.assign(new Error('天数要在 ±3650 之间且不为 0'), { statusCode: 400 });
    }
    const from = Math.max(paidUntil(pid), now());
    setSetting(pid, 'billing.paidUntil', String(Math.max(0, from + days * 86400)));
  }
  return adminState(pid);
}

/**
 * 给一台盒子直接发观看权，不收钱。前台补偿、测试、VIP 房都用得上。
 *
 * `pid` 不是装饰：没有它，A 店的前台知道 B 店某台盒子的 id 就能给它发观看权。
 * 平台管理员传 null 表示不限制，酒店管理员必须传自己的 id。
 */
export function grantPass(pid, deviceId, days) {
  const d = Math.trunc(Number(days));
  if (!Number.isFinite(d) || Math.abs(d) > 3650) {
    throw Object.assign(new Error('天数要在 ±3650 之间'), { statusCode: 400 });
  }
  const dev = db
    .prepare(
      pid == null
        ? 'SELECT content_until FROM devices WHERE device_id = ?'
        : 'SELECT content_until FROM devices WHERE device_id = ? AND property_id = ?',
    )
    .get(...(pid == null ? [String(deviceId)] : [String(deviceId), pid]));
  if (!dev) return null;
  const from = Math.max(Number(dev.content_until ?? 0), now());
  db.prepare('UPDATE devices SET content_until = ? WHERE device_id = ?')
    .run(Math.max(0, from + d * 86400), String(deviceId));
  return db.prepare('SELECT content_until FROM devices WHERE device_id = ?').get(String(deviceId));
}
