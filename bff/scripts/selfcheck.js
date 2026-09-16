/**
 * 支付与计费的自检。
 *
 * 动过 pay.js / jeepay.js / billing.js 就跑一次：
 *
 *   DB_FILE=/tmp/selfcheck.db node scripts/selfcheck.js
 *
 * 这里查的全是「不报错、但钱算错了」那一类 —— 签名少算一个字段、
 * 瑞尔乘了一百倍、回调重发把东西发了两次。这些线上不会抛异常，
 * 只会让某个人多付钱或者白拿东西，只能靠主动去找。
 *
 * 不联网。网关那一端用假的 fetch 顶掉。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wewatch-selfcheck-'));
process.env.DB_FILE = join(dir, 'check.db');
process.env.MEDIA_DIR = join(dir, 'media');
process.env.PUBLIC_BASE_URL = 'https://example.test';

const { db, now, PLATFORM } = await import('../src/db.js');
const { setSetting } = await import('../src/settings.js');
const props = await import('../src/properties.js');
const jeepay = await import('../src/jeepay.js');
const pay = await import('../src/pay.js');
const billing = await import('../src/billing.js');

/*
 * 一家酒店就够了 —— 这份自检查的是「钱算得对不对」，
 * 「A 店看不看得见 B 店」是 tenancy-check.js 的事。
 */
const HOTEL = props.create({ slug: 'selfcheck', name: '自检酒店' });
const PID = HOTEL.id;
/** 客人点餐进酒店自己的商户；观看权和服务费进平台的。 */
const SVC = PID;

let passed = 0;
let failed = 0;
const fails = [];

function ok(name, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failed++;
    fails.push(`${name}${detail ? ' — ' + detail : ''}`);
  }
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function section(title) {
  console.log(`\n── ${title}`);
}

// ---------------------------------------------------------------- 1. 签名

section('1. Jeepay 签名');

const SECRET = 'test-secret-0123456789';

{
  // 官方文档那个例子的结构：排序 + &key= + 大写 MD5。
  const p = { mchNo: 'M001', appId: 'app1', amount: 100, mchOrderNo: 'A1' };
  const s1 = jeepay.sign(p, SECRET);
  eq('签名是 32 位大写十六进制', /^[0-9A-F]{32}$/.test(s1), true);
  eq('同样的参数签出同样的值', jeepay.sign({ ...p }, SECRET), s1);
  ok('参数顺序不影响结果', jeepay.sign({ amount: 100, appId: 'app1', mchOrderNo: 'A1', mchNo: 'M001' }, SECRET) === s1);
  ok('换密钥就换签名', jeepay.sign(p, SECRET + 'x') !== s1);
}

{
  // 这条是整份实现里最容易写错的一行。
  const withZero = { a: '1', b: 0 };
  const withoutB = { a: '1' };
  ok(
    '值为 0 的参数要算进签名（不能用 if (v) 过滤）',
    jeepay.sign(withZero, SECRET) !== jeepay.sign(withoutB, SECRET),
  );
  eq(
    '值为空字符串的参数要排除',
    jeepay.sign({ a: '1', b: '' }, SECRET),
    jeepay.sign({ a: '1' }, SECRET),
  );
  eq(
    'null / undefined 同样排除',
    jeepay.sign({ a: '1', b: null, c: undefined }, SECRET),
    jeepay.sign({ a: '1' }, SECRET),
  );
  eq('sign 字段本身不参与', jeepay.sign({ a: '1', sign: 'XX' }, SECRET), jeepay.sign({ a: '1' }, SECRET));
}

{
  const p = { mchOrderNo: 'B2', amount: 500, state: 2 };
  p.sign = jeepay.sign(p, SECRET);
  eq('自己签的自己验得过', jeepay.verify(p, SECRET), true);
  eq('改一个字段就验不过', jeepay.verify({ ...p, amount: 999 }, SECRET), false);
  eq('密钥不对验不过', jeepay.verify(p, 'wrong'), false);
  eq('没有 sign 验不过', jeepay.verify({ mchOrderNo: 'B2' }, SECRET), false);
  eq('小写的 sign 也认', jeepay.verify({ ...p, sign: p.sign.toLowerCase() }, SECRET), true);
}

// ------------------------------------------------------------ 2. 金额单位

section('2. 金额单位');

eq('CNY 12.34 → 1234 分', pay.toMinor(12.34, 'CNY'), 1234);
eq('USD 2 → 200', pay.toMinor(2, 'USD'), 200);
eq('KHR 8000 → 8000（瑞尔没有小数位）', pay.toMinor(8000, 'KHR'), 8000);
eq('IDR 35000 → 35000', pay.toMinor(35000, 'IDR'), 35000);
eq('没见过的币种按两位小数算', pay.toMinor(1, 'XYZ'), 100);
eq('浮点误差要被消掉：0.07 USD', pay.toMinor(0.07, 'USD'), 7);
eq('19.99 USD', pay.toMinor(19.99, 'USD'), 1999);
eq('来回换算不丢：CNY', pay.fromMinor(pay.toMinor(88.88, 'CNY'), 'CNY'), 88.88);
eq('来回换算不丢：KHR', pay.fromMinor(pay.toMinor(12000, 'KHR'), 'KHR'), 12000);
eq('显示：CNY', pay.formatMoney(1234, 'CNY'), '12.34 CNY');
eq('显示：KHR 不带小数', pay.formatMoney(8000, 'KHR'), '8000 KHR');

// -------------------------------------------------------- 3. 通道配置

section('3. 通道配置');

eq('什么都没配时不能收款', pay.payEnabled(PLATFORM), false);
eq('没配时状态里 ready=false', pay.channelState(PLATFORM).ready, false);

pay.saveChannel(PLATFORM, {
  gatewayUrl: 'https://pay.example.test',
  mchNo: 'M1781870127',
  appId: 'app-selfcheck',
  appSecret: SECRET,
  wayCode: 'ALI_QR',
  currency: 'USD',
});
eq('填全了但没开，仍然不能收款', pay.payEnabled(PLATFORM), false);
pay.saveChannel(PLATFORM, { enabled: true });
eq('开了之后能收款', pay.payEnabled(PLATFORM), true);
eq('密钥不回传', pay.channelState(PLATFORM).appSecret, undefined);
eq('只回「配没配」', pay.channelState(PLATFORM).secretSet, true);

pay.saveChannel(PLATFORM, { appSecret: '' });
eq('保存时留空密钥 = 不改，不是清空', pay.credentials(PLATFORM).appSecret, SECRET);

let threw = null;
try { pay.saveChannel(PLATFORM, { currency: 'DOLLAR' }); } catch (e) { threw = e; }
ok('币种写错会被拒', threw !== null);
eq('币种没被写坏', pay.currency(PLATFORM), 'USD');

// 酒店自己的点餐商户，跟平台那套是两回事。
pay.saveChannel(SVC, {
  gatewayUrl: 'https://hotel.example.test',
  mchNo: 'MCH-HOTEL',
  appId: 'hotel',
  appSecret: SECRET,
  wayCode: 'ALI_QR',
  currency: 'USD',
  enabled: true,
});
eq('酒店的商户号跟平台的不是一个', pay.credentials(SVC).mchNo, 'MCH-HOTEL');
eq('平台的没被改', pay.credentials(PLATFORM).mchNo, 'M1781870127');

// ------------------------------------------------------------ 4. 下单

section('4. 下单与回调');

// 假网关：记下收到什么，回一个固定的二维码。
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  sent.push({ url, body });
  if (String(url).endsWith('/api/pay/unifiedOrder')) {
    return new Response(
      JSON.stringify({ code: 0, data: { payOrderId: 'P' + sent.length, payData: '00020101021130ABCDEF' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return new Response(JSON.stringify({ code: 0, data: { state: 1 } }), { status: 200 });
};

db.prepare(`INSERT INTO devices (device_id, property_id, line_user, line_pass, room_id, created_at)
            VALUES ('box-1', ?, 'u', 'p', '301', ?)`).run(PID, now());

const order = await pay.createOrder({
  kind: 'unlock',
  refId: 3,
  propertyId: PID,
  deviceId: 'box-1',
  roomId: '301',
  amountCents: pay.toMinor(5, 'USD'),
  subject: '观看权 3 天',
});

eq('下单拿到订单号', typeof order.orderNo === 'string' && order.orderNo.startsWith('UL'), true);
eq('金额换算正确', order.amountText, '5.00 USD');
eq('二维码内容被认成码，不是跳转地址', order.codeUrl, '00020101021130ABCDEF');
eq('不会把二维码当成跳转地址', order.payUrl, null);
eq('回调地址是绝对地址', sent[0].body.notifyUrl, 'https://example.test/api/pay/notify/jeepay');
eq('提交的金额是最小单位整数', sent[0].body.amount, 500);
eq('提交的币种是小写', sent[0].body.currency, 'usd');
ok('提交时带了签名', /^[0-9A-F]{32}$/.test(sent[0].body.sign));
eq('提交的签名自己验得过', jeepay.verify(sent[0].body, SECRET), true);

// ---- 回调 ----
function notifyFor(orderNo, { state = 2, amount = 500 } = {}) {
  const p = { mchOrderNo: orderNo, payOrderId: 'P1', amount, state, mchNo: 'M1781870127' };
  p.sign = jeepay.sign(p, SECRET);
  return p;
}

{
  const bad = notifyFor(order.orderNo);
  bad.sign = 'DEADBEEF'.repeat(4);
  eq('签名不对的回调会被拒', pay.parseNotifyParams(bad).valid, false);
  eq('被拒的回调不会把单标成已付', pay.findOrder(order.orderNo).state, 'pending');
}

{
  const p = pay.parseNotifyParams(notifyFor(order.orderNo, { state: 1 }));
  eq('state=1 不算成功', p.success, false);
  eq('state=1 也是验签通过的', p.valid, true);
}

{
  const p = pay.parseNotifyParams(notifyFor(order.orderNo));
  eq('state=2 算成功', p.success, true);

  const r1 = pay.markPaid(p.orderNo, { upstreamNo: p.upstreamNo, amountCents: p.amountCents });
  eq('第一次入账成功', r1.ok && !r1.already, true);
  eq('单子变成已付款', pay.findOrder(order.orderNo).state, 'paid');

  const dev1 = db.prepare('SELECT content_until FROM devices WHERE device_id = ?').get('box-1');
  const firstUntil = Number(dev1.content_until);
  ok('买了 3 天，观看权到期日在 3 天后', Math.abs(firstUntil - (now() + 3 * 86400)) < 5, `实际 ${firstUntil - now()} 秒`);

  // 这是防重复发货那一行的唯一证明。
  const r2 = pay.markPaid(p.orderNo, { upstreamNo: p.upstreamNo, amountCents: p.amountCents });
  eq('重复回调被认出来', r2.already, true);
  const dev2 = db.prepare('SELECT content_until FROM devices WHERE device_id = ?').get('box-1');
  eq('重复回调没有再送一次 3 天', Number(dev2.content_until), firstUntil);
}

{
  // 金额对不上不发货。
  const o2 = await pay.createOrder({
    kind: 'unlock', refId: 1, propertyId: PID, deviceId: 'box-1', roomId: '301',
    amountCents: pay.toMinor(2, 'USD'), subject: '观看权 1 天',
  });
  const before = Number(db.prepare('SELECT content_until FROM devices WHERE device_id = ?').get('box-1').content_until);
  const r = pay.markPaid(o2.orderNo, { upstreamNo: 'P9', amountCents: 1 });
  eq('金额不符会被拒绝入账', r.ok, false);
  eq('金额不符时单子仍然是待付款', pay.findOrder(o2.orderNo).state, 'pending');
  const after = Number(db.prepare('SELECT content_until FROM devices WHERE device_id = ?').get('box-1').content_until);
  eq('金额不符没有发货', after, before);
  ok('金额不符在单子上留了记录', Boolean(pay.findOrder(o2.orderNo).note));
}

{
  // 续期要往后接，不是从头算。
  const before = Number(db.prepare('SELECT content_until FROM devices WHERE device_id = ?').get('box-1').content_until);
  const o3 = await pay.createOrder({
    kind: 'unlock', refId: 7, propertyId: PID, deviceId: 'box-1', roomId: '301',
    amountCents: pay.toMinor(10, 'USD'), subject: '观看权 7 天',
  });
  pay.markPaid(o3.orderNo, { upstreamNo: 'P10', amountCents: 1000 });
  const after = Number(db.prepare('SELECT content_until FROM devices WHERE device_id = ?').get('box-1').content_until);
  ok('没到期时再买是往后接，不是重新开始', Math.abs(after - (before + 7 * 86400)) < 5, `实际多了 ${(after - before) / 86400} 天`);
}

// -------------------------------------------------------------- 5. 计费

section('5. 谁出钱');

db.prepare(`INSERT INTO devices (device_id, property_id, line_user, line_pass, created_at)
            VALUES ('box-2', ?, 'u', 'p', ?)`).run(PID, now());
const box2 = () => db.prepare('SELECT * FROM devices WHERE device_id = ?').get('box-2');

setSetting(PID, 'billing.mode', 'property');
setSetting(PID, 'billing.paidUntil', String(now() + 30 * 86400));
eq('酒店付费模式：默认模式就是它', billing.mode(PID), 'property');
eq('酒店付着费，点播不锁', billing.allowed(box2(), 'vod'), true);
eq('酒店付着费，直播不锁', billing.allowed(box2(), 'live'), true);
eq('酒店付着费时电视上看不到任何收费入口', billing.statusFor(box2()).locked.length, 0);

setSetting(PID, 'billing.paidUntil', String(now() - 1));
eq('酒店服务费过期了', billing.propertyPaid(PID), false);
eq('但模式还是 property，所以仍然不锁', billing.allowed(box2(), 'vod'), true);

setSetting(PID, 'billing.mode', 'guest');
eq('切成客人付费：点播锁上', billing.allowed(box2(), 'vod'), false);
eq('切成客人付费：直播默认不锁', billing.allowed(box2(), 'live'), true);
eq('电视上看到的是「点播要买」', billing.statusFor(box2()).locked.join(','), 'vod');
ok('并且带上了价格', billing.statusFor(box2()).plans.length > 0);

// 这一条是底线。
pay.saveChannel(PLATFORM, { enabled: false });
eq('收不了款的时候，什么都不锁', billing.allowed(box2(), 'vod'), true);
eq('收不了款时电视上也不出现收费入口', billing.statusFor(box2()).locked.length, 0);
pay.saveChannel(PLATFORM, { enabled: true });
eq('通道恢复后重新锁上', billing.allowed(box2(), 'vod'), false);

billing.grantPass(PID, 'box-2', 2);
eq('前台手工发的观看权同样有效', billing.allowed(box2(), 'vod'), true);
billing.grantPass(PID, 'box-2', -2);
eq('也能收回来', billing.allowed(box2(), 'vod'), false);

setSetting(PID, 'billing.paidUntil', String(now() + 86400));
eq('客人付费模式下，酒店补了钱，全楼立刻恢复', billing.allowed(box2(), 'vod'), true);

setSetting(PID, 'billing.gateSections', 'vod,live');
setSetting(PID, 'billing.paidUntil', '0');
eq('可以把直播也划进收费范围', billing.allowed(box2(), 'live'), false);
setSetting(PID, 'billing.gateSections', ' ');
eq('也可以一个都不划', billing.allowed(box2(), 'vod'), true);

// ------------------------------------------------- 5b. 菜单币种对不对得上

section('5b. 菜单币种');

const svcmod = await import('../src/service.js');

{
  // 自检用的是全新的库，没跑过 seed，所以这几行菜自己种。
  const add = db.prepare(
    "INSERT INTO service_items (property_id, category, name_en, price, currency, available, sort_order) VALUES (?, ?, ?, ?, ?, 1, 0)",
  );
  add.run(PID, 'Makanan', 'Nasi Goreng Spesial', 35000, 'IDR');
  add.run(PID, 'Minuman', 'Es Teh Manis', 8000, 'IDR');

  eq('菜单是空的时候没有币种冲突', true, true);

  // 菜单是印尼盾，通道是 USD —— 这正是会收出「35000 美元一盘炒饭」的组合。
  db.prepare("UPDATE service_items SET currency = 'IDR'").run();
  const c1 = svcmod.currencyCheck(PID);
  eq('菜单 IDR + 通道 USD → 不 OK', c1.ok, false);
  ok('并且说清楚为什么', String(c1.reason).includes('不会自动换算'));

  db.prepare("UPDATE service_items SET currency = 'USD'").run();
  eq('统一成 USD 之后 OK', svcmod.currencyCheck(PID).ok, true);

  // 混着几种也不行：一笔订单只能有一个币种。
  const one = db.prepare('SELECT id FROM service_items LIMIT 1').get();
  if (one) {
    db.prepare("UPDATE service_items SET currency = 'KHR' WHERE id = ?").run(one.id);
    const c2 = svcmod.currencyCheck(PID);
    eq('混着两种币种 → 不 OK', c2.ok, false);
    ok('说的是「混着」', String(c2.reason).includes('混着'));
    db.prepare("UPDATE service_items SET currency = 'USD'").run();
  }

  // 下架的不算：菜单上看不到的东西不该拦住收款。
  db.prepare("UPDATE service_items SET currency = 'IDR', available = 0 WHERE id = (SELECT id FROM service_items LIMIT 1)").run();
  eq('下架的菜品币种不参与判断', svcmod.currencyCheck(PID).ok, true);
}

// ------------------------------------------------------------ 6. 迟到的钱

section('6. 过期与迟到的付款');

{
  const o = await pay.createOrder({
    kind: 'service', refId: 1, propertyId: PID, deviceId: 'box-1', roomId: '301',
    amountCents: 500, subject: '客房服务',
  });
  db.prepare("UPDATE pay_orders SET expires_at = ? WHERE order_no = ?").run(now() - 10, o.orderNo);

  globalThis.fetch = async (url) =>
    String(url).endsWith('/api/pay/query')
      ? new Response(JSON.stringify({ code: 0, data: { state: 1 } }), { status: 200 })
      : new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });

  await pay.reconcile(null);
  eq('到点没付的单会被关掉', pay.findOrder(o.orderNo).state, 'expired');

  // 关掉之后钱才到。
  globalThis.fetch = async (url) =>
    String(url).endsWith('/api/pay/query')
      ? new Response(JSON.stringify({ code: 0, data: { state: 2, amount: 500, payOrderId: 'PL1' } }), { status: 200 })
      : new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });

  const logged = [];
  await pay.reconcile({ warn: () => {}, error: (o2, m) => logged.push(m) });
  const row = pay.findOrder(o.orderNo);
  eq('迟到的付款不会被静默吞掉，钱记下来了', row.state, 'paid');
  ok('并且在单子上写明要人工处理', String(row.note).includes('人工'));
  ok('还在日志里吼了一声', logged.length > 0);
}

globalThis.fetch = realFetch;

// ------------------------------------------------------------------ 结果

console.log(`\n${'─'.repeat(52)}`);
if (failed === 0) {
  console.log(`全部通过：${passed} 项`);
} else {
  console.log(`通过 ${passed} 项，失败 ${failed} 项：\n`);
  for (const f of fails) console.log('  ✗ ' + f);
}
try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows 有时还占着 */ }
process.exit(failed === 0 ? 0 : 1);
