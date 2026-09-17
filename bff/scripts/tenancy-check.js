/**
 * 多租户隔离自检。
 *
 *   DB_FILE=<临时库> node scripts/tenancy-check.js
 *
 * 这里查的是同一类问题：**A 店看得见/改得动 B 店的东西**。
 * 这些线上不会报错 —— 只会是 B 店的客人发现自己的姓名变成了别人的，
 * 或者一家交了服务费十家一起免费。只能靠主动去撞。
 *
 * 建两家酒店，各放一台盒子，都叫 301 房，然后逐条撞。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wewatch-tenancy-'));
process.env.DB_FILE = join(dir, 'check.db');
process.env.MEDIA_DIR = join(dir, 'media');
process.env.PUBLIC_BASE_URL = 'https://example.test';

const { db, now, PLATFORM } = await import('../src/db.js');
const settings = await import('../src/settings.js');
const props = await import('../src/properties.js');
const rooms = await import('../src/rooms.js');
const adult = await import('../src/adult.js');
const billing = await import('../src/billing.js');
const pay = await import('../src/pay.js');
const svc = await import('../src/service.js');

let passed = 0;
const fails = [];
const ok = (name, cond, detail) =>
  cond ? passed++ : fails.push(`${name}${detail ? ' — ' + detail : ''}`);
const eq = (name, a, b) =>
  ok(name, Object.is(a, b), `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const section = (t) => console.log(`\n── ${t}`);

// ------------------------------------------------------------ 建两家酒店

section('1. 两家酒店，各一台盒子，房间都叫 301');

const A = props.create({ slug: 'angkor', name: '吴哥大酒店' });
const B = props.create({ slug: 'mekong', name: '湄公河酒店' });
eq('A 是 1 号', A.id, 1);
eq('B 是 2 号', B.id, 2);

let threw = null;
try {
  props.create({ slug: 'angkor', name: '重名' });
} catch (e) {
  threw = e;
}
ok('标识不能重复', threw !== null);

const mkBox = (id, pid) =>
  db
    .prepare(
      "INSERT INTO devices (device_id, property_id, room_id, line_user, line_pass, last_seen, created_at) VALUES (?, ?, '301', 'u', 'p', ?, ?)",
    )
    .run(id, pid, now(), now());
mkBox('box-a', A.id);
mkBox('box-b', B.id);
rooms.ensureRoom(A.id, '301');
rooms.ensureRoom(B.id, '301');

const boxA = () => db.prepare("SELECT * FROM devices WHERE device_id = 'box-a'").get();
const boxB = () => db.prepare("SELECT * FROM devices WHERE device_id = 'box-b'").get();
const roomA = () => db.prepare("SELECT * FROM rooms WHERE property_id = ? AND room_id = '301'").get(A.id);
const roomB = () => db.prepare("SELECT * FROM rooms WHERE property_id = ? AND room_id = '301'").get(B.id);

eq('两家各有一个 301', db.prepare("SELECT COUNT(*) n FROM rooms WHERE room_id = '301'").get().n, 2);

// ------------------------------------------------------------ 入住 / 退房

section('2. 入住与退房');

rooms.checkIn(A.id, '301', '张三');
rooms.checkIn(B.id, '301', '李四');
eq('A 店 301 住的是张三', roomA().guest_name, '张三');
eq('B 店 301 住的是李四', roomB().guest_name, '李四');

adult.setDeviceAllowed('box-a', true);
adult.setDeviceAllowed('box-b', true);

rooms.checkOut(A.id, '301');
eq('A 店退房清了自己的姓名', roomA().guest_name, null);
eq('**B 店的姓名没被动**', roomB().guest_name, '李四');
eq('A 店的成人授权被收回', Boolean(boxA().adult_allowed), false);
eq('**B 店的成人授权没被收回**', Boolean(boxB().adult_allowed), true);

// ---------------------------------------------------------- 改不到别家

section('3. A 店改不动 B 店的东西');

eq('A 改不了 B 的盒子', rooms.saveDevice(A.id, 'box-b', { label: '偷改' }), null);
eq('B 的备注没变', boxB().label, null);
eq('A 删不掉 B 的盒子', rooms.removeDevice(A.id, 'box-b'), false);
ok('B 的盒子还在', Boolean(boxB()));
eq('A 给 B 的盒子发不了观看权', billing.grantPass(A.id, 'box-b', 30), null);
eq('B 的盒子还是没有观看权', boxB().content_until ?? null, null);
ok('平台可以（pid 传 null）', billing.grantPass(null, 'box-b', 30) !== null);
// 刚刚为了验证平台权限给 B 发了 30 天，收回来 —— 后面第 5 节要验「没交钱就锁上」，
// 留着的话那一条会因为这里的副作用而假绿。
billing.grantPass(null, 'box-b', -3650);
eq('收回之后 B 没有观看权', billing.passActive(boxB()), false);

const rmB = rooms.removeRoom(A.id, '301');
eq('A 删不掉 B 的房间', rmB.ok, false);
ok('B 的 301 还在', Boolean(roomB()));

// ------------------------------------------------------------ 配置分家

section('4. 品牌、成人板块、菜单各归各的');

settings.setSetting(A.id, 'home.propertyName', '吴哥大酒店');
settings.setSetting(B.id, 'home.propertyName', '湄公河酒店');
eq('A 的电视显示 A 的名字', settings.homeConfig(A.id).propertyName, '吴哥大酒店');
eq('B 的电视显示 B 的名字', settings.homeConfig(B.id).propertyName, '湄公河酒店');

settings.setSetting(A.id, 'home.bg.type', 'image');
settings.setSetting(A.id, 'home.bg.url', '/media/a.jpg');
eq('A 有自己的背景', settings.homeConfig(A.id).background.url, '/media/a.jpg');
eq('B 没被连带', settings.homeConfig(B.id).background.url, null);

/*
 * 电视模板也要分家。
 *
 * 这一项漏了不会报错，只会是：给 A 店切了「直播优先」，B 店的客人第二天
 * 早上开机发现自己的首页没了。跟改名字、改背景是同一类错误，所以放在一起撞。
 */
eq('默认是酒店门户', settings.tvConfig(B.id).template, 'portal');
settings.setTv(A.id, { template: 'live' });
eq('A 换成直播优先', settings.tvConfig(A.id).template, 'live');
eq('B 没被连带', settings.tvConfig(B.id).template, 'portal');
eq('电视配置随首页一起下发', settings.homeConfig(A.id).tv.template, 'live');
{
  let threw = null;
  try {
    settings.setTv(B.id, { template: 'whatever' });
  } catch (err) {
    threw = err;
  }
  ok('不认识的模板名被拒', threw !== null);
  eq('被拒之后 B 还是门户', settings.tvConfig(B.id).template, 'portal');
}

adult.setPin(A.id, '1234');
eq('A 设了 PIN', adult.pinIsSet(A.id), true);
eq('**B 没有 PIN**', adult.pinIsSet(B.id), false);
settings.setSetting(A.id, 'adult.enabled', '1');
eq('A 开了成人板块', adult.adultEnabled(A.id), true);
eq('B 没开', adult.adultEnabled(B.id), false);

adult.setPickedCategories(A.id, ['vod:43']);
eq('A 勾了一个受限分类', adult.pickedCategories(A.id).join(), 'vod:43');
eq('**B 一个都没勾**', adult.pickedCategories(B.id).length, 0);
eq('同一个分类在 A 是受限的', adult.isAdultCategory(A.id, '剧情片', 'vod', '43'), true);
eq('在 B 就是普通分类', adult.isAdultCategory(B.id, '剧情片', 'vod', '43'), false);

svc.saveItem(A.id, { category: 'Drinks', name: { en: 'Angkor Beer' }, price: 2.5, currency: 'USD' });
svc.saveItem(B.id, { category: 'Food', name: { en: 'Amok' }, price: 6, currency: 'USD' });
eq('A 的菜单只有自己的', svc.menu(A.id).length, 1);
eq('B 的菜单只有自己的', svc.menu(B.id).length, 1);
eq('A 菜单第一项', svc.menu(A.id)[0].name.en, 'Angkor Beer');

const bItem = svc.menu(B.id)[0].id;
eq('A 改不了 B 的菜品', svc.saveItem(A.id, { id: bItem, price: 999 }), null);
eq('B 的价格没变', svc.menu(B.id)[0].price, 6);
eq('A 删不掉 B 的菜品', svc.removeItem(A.id, bItem), false);

// -------------------------------------------------------------- 计费分家

section('5. 一家交钱不等于十家免费');

settings.setSetting(A.id, 'billing.paidUntil', String(now() + 30 * 86400));
eq('A 交了服务费', billing.propertyPaid(A.id), true);
eq('**B 没交就是没交**', billing.propertyPaid(B.id), false);

settings.setSetting(A.id, 'billing.mode', 'guest');
settings.setSetting(B.id, 'billing.mode', 'guest');
pay.saveChannel(PLATFORM, {
  gatewayUrl: 'https://pay.example.test',
  mchNo: 'PLATFORM',
  appId: 'p',
  appSecret: 'platform-secret',
  enabled: true,
  currency: 'USD',
});
eq('A 交着费，点播不锁', billing.allowed(boxA(), 'vod'), true);
eq('B 没交，点播锁上', billing.allowed(boxB(), 'vod'), false);

settings.setSetting(B.id, 'billing.guestPlans', JSON.stringify([{ days: 1, price: 3 }]));
eq('B 的档位是自己配的', billing.guestPlans(B.id)[0].price, 3);
eq('A 用的是默认档位', billing.guestPlans(A.id)[0].price, 2);

// ---------------------------------------------------------------- 钱的去向

section('6. 钱进谁的口袋');

eq('点餐 → 这家酒店的商户', pay.scopeOf('service', A.id), A.id);
eq('点餐（B 店）→ B 的商户', pay.scopeOf('service', B.id), B.id);
eq('观看权 → 平台商户', pay.scopeOf('unlock', A.id), PLATFORM);
eq('服务费 → 平台商户', pay.scopeOf('property', A.id), PLATFORM);

pay.saveChannel(A.id, {
  gatewayUrl: 'https://a.example.test',
  mchNo: 'MCH-A',
  appId: 'a',
  appSecret: 'secret-a',
  enabled: true,
  currency: 'USD',
});
eq('A 配了自己的点餐商户', pay.credentials(A.id).mchNo, 'MCH-A');
eq('**B 还没配**', pay.credentials(B.id).mchNo, '');
eq('平台商户是另一个', pay.credentials(PLATFORM).mchNo, 'PLATFORM');
eq('A 能收点餐款', pay.payEnabled(pay.scopeOf('service', A.id)), true);
eq('B 收不了点餐款', pay.payEnabled(pay.scopeOf('service', B.id)), false);
eq('但 B 的观看权照样能卖（走平台）', pay.payEnabled(pay.scopeOf('unlock', B.id)), true);

// 服务费入账只延这一家
{
  const before = Number(settings.getSetting(B.id, 'billing.paidUntil') ?? 0);
  const aBefore = Number(settings.getSetting(A.id, 'billing.paidUntil') ?? 0);
  db.prepare(
    `INSERT INTO pay_orders (order_no, kind, ref_id, property_id, amount_cents, currency, way_code, subject, state, created_at, expires_at)
     VALUES ('PRTEST', 'property', '30', ?, 100, 'USD', 'X', '服务费', 'pending', ?, ?)`,
  ).run(B.id, now(), now() + 900);
  pay.markPaid('PRTEST', { amountCents: 100 });
  const after = Number(settings.getSetting(B.id, 'billing.paidUntil') ?? 0);
  ok('B 交费后 B 的到期日往后走了', after > before, `${before} → ${after}`);
  eq('**A 的到期日没被动**', Number(settings.getSetting(A.id, 'billing.paidUntil') ?? 0), aBefore);
}

// ---------------------------------------------------------------- 后台视野

section('7. 后台看到的范围');

const rosterA = rooms.roster(A.id);
eq('A 的后台只看到一台盒子', rosterA.devices.length, 1);
eq('而且是自己的', rosterA.devices[0].deviceId, 'box-a');
eq('A 的后台只看到一个房间', rosterA.rooms.length, 1);
eq('平台看到两台', rooms.roster(null).devices.length, 2);
eq('平台看到两个房间', rooms.roster(null).rooms.length, 2);

// ------------------------------------------------------------ 登录

section('8. 两层登录');

props.setToken(A.id, 'angkor-pass-1');
props.setToken(B.id, 'mekong-pass-2');
eq('A 的口令开 A 的门', props.authenticate('angkor-pass-1')?.id, A.id);
eq('B 的口令开 B 的门', props.authenticate('mekong-pass-2')?.id, B.id);
eq('乱填开不了', props.authenticate('nope'), null);
eq('空口令开不了', props.authenticate(''), null);

props.save(B.id, { active: 0 });
eq('停用之后它的口令也开不了', props.authenticate('mekong-pass-2'), null);
props.save(B.id, { active: 1 });

threw = null;
try {
  props.setToken(A.id, 'short');
} catch (e) {
  threw = e;
}
ok('太短的口令被拒', threw !== null);
eq('原来的口令还好用', props.authenticate('angkor-pass-1')?.id, A.id);

// ------------------------------------------------------- 漏带酒店会炸

section('9. 漏带酒店 id 的调用会立刻炸掉');

for (const [name, fn] of [
  ['getSetting 漏带', () => settings.getSetting('home.propertyName')],
  ['setSetting 漏带', () => settings.setSetting('home.propertyName', 'x')],
]) {
  let t = null;
  try {
    fn();
  } catch (e) {
    t = e;
  }
  ok(name + ' → 抛异常，而不是安静地读到别家', t !== null && /酒店 id/.test(t.message));
}

// ---------------------------------------------------------------- 删店

section('10. 删掉一家');

props.remove(B.id);
eq('B 没了', props.find(B.id), null);
eq('B 的房间没了', db.prepare('SELECT COUNT(*) n FROM rooms WHERE property_id = ?').get(B.id).n, 0);
eq('B 的菜单没了', db.prepare('SELECT COUNT(*) n FROM service_items WHERE property_id = ?').get(B.id).n, 0);
eq('B 的配置没了', db.prepare('SELECT COUNT(*) n FROM settings WHERE property_id = ?').get(B.id).n, 0);
ok('但盒子还在（硬件是真的，只是解绑）', Boolean(boxB()));
eq('盒子已解绑', boxB().property_id, null);
eq('**A 完全没受影响**', settings.homeConfig(A.id).propertyName, '吴哥大酒店');
eq('A 的盒子还在', rooms.roster(A.id).devices.length, 1);

// -------------------------------------------------------- 无主的盒子

section('11. 无主的盒子：在哪家的表里填房间号，就归哪家');

/*
 * 十家共用一个 APK，所以插电开机的那一刻服务端认不出这台是谁的：
 * property_id 为空，屏幕上停在配对码那一页。把它划给某一家的动作，
 * 界面上**只有**「房间与设备」这张表能做 —— roster 把无主的盒子也列出来
 * 就是为了这一下。
 *
 * 这一节撞的是一个真出过的坑：以前填了房间号会当场「已保存」，但盒子
 * 既没归属也没线路，房间号写进了一家 id 为 0 的、根本不存在的酒店底下
 * （SQLite 的 NULL 经 Number() 变成 0，再被 Number.isInteger 放行）。
 * 电视上于是永远停在配对码那一页，而后台什么都没说。
 */
db.prepare('UPDATE properties SET line_user = ?, line_pass = ? WHERE id = ?')
  .run('lineA', 'passA', A.id);

const mkOrphan = (id, code) =>
  db
    .prepare(
      'INSERT INTO devices (device_id, code, property_id, room_id, line_user, line_pass, last_seen, created_at) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?)',
    )
    .run(id, code, now(), now());
mkOrphan('box-new', '654321');
const boxNew = () => db.prepare("SELECT * FROM devices WHERE device_id = 'box-new'").get();

eq('酒店管理员碰不到无主的盒子', rooms.saveDevice(A.id, 'box-new', { roomId: '505' }), null);

const saved = rooms.saveDevice(null, 'box-new', { roomId: '505' }, { adoptInto: A.id });
eq('控制台被告知划给了哪家', saved.adoptedInto, '吴哥大酒店');
eq('盒子归了 A', boxNew().property_id, A.id);
eq('房间号写下来了', boxNew().room_id, '505');
eq('**同时拿到了 A 的线路**', boxNew().line_user, 'lineA');
eq('配对码作废', boxNew().code, null);
ok(
  '505 这个房间建在 A 底下',
  Boolean(db.prepare('SELECT 1 FROM rooms WHERE property_id = ? AND room_id = ?').get(A.id, '505')),
);
eq(
  '**没有挂在不存在的酒店底下的房间**',
  db
    .prepare('SELECT COUNT(*) n FROM rooms WHERE property_id NOT IN (SELECT id FROM properties)')
    .get().n,
  0,
);

// 没说是哪一家就不能猜。宁可报错，也不要再写进一家不存在的店。
mkOrphan('box-new2', '654322');
let threwOrphan = null;
try {
  rooms.saveDevice(null, 'box-new2', { roomId: '506' });
} catch (e) {
  threwOrphan = e.message;
}
ok('没指明哪家时报错，而不是默默存下', threwOrphan !== null, '居然没报错');
eq(
  '报错之后房间也没被建出来',
  db.prepare("SELECT COUNT(*) n FROM rooms WHERE room_id = '506'").get().n,
  0,
);

// 一家还没配线路时，只认领、不要把配对码也抹掉 ——
// 否则电视上会变成既没有码也没有内容的 '------'。
const C = props.create({ slug: 'noline', name: '还没配线路的店' });
mkOrphan('box-new3', '654323');
const savedC = rooms.saveDevice(null, 'box-new3', { roomId: '507' }, { adoptInto: C.id });
const boxNew3 = () => db.prepare("SELECT * FROM devices WHERE device_id = 'box-new3'").get();
eq('没线路的店照样认领得了', boxNew3().property_id, C.id);
eq('但配对码留着', boxNew3().code, '654323');
eq('也没写下半截线路', boxNew3().line_user, null);
ok('认领仍然要说出来', savedC.adoptedInto === '还没配线路的店');

// ---------------------------------------------------------------- 结果

console.log(`\n${'─'.repeat(52)}`);
if (!fails.length) {
  console.log(`全部通过：${passed} 项`);
} else {
  console.log(`通过 ${passed} 项，失败 ${fails.length} 项：\n`);
  for (const f of fails) console.log('  ✗ ' + f);
}
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* windows 有时还占着 */
}
process.exit(fails.length ? 1 : 0);
