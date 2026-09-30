/**
 * 后台权限自检。
 *
 *   node scripts/auth-check.js
 *
 * 查的是同一类问题：**前台点不到的东西，他直接调接口能不能调到。**
 * 界面上藏按钮是体验，这里查的才是权限 —— 两者差一个 F12。
 *
 * 另外还查登录限速和会话的生死：这个控制台挂在公网域名上，
 * 原来密码是可以无限次猜的。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kdtv-auth-'));
process.env.DB_FILE = join(dir, 'check.db');
process.env.MEDIA_DIR = join(dir, 'media');

const props = await import('../src/properties.js');
const auth = await import('../src/adminauth.js');

let passed = 0;
const fails = [];
const ok = (name, cond, detail) =>
  cond ? passed++ : fails.push(`${name}${detail ? ' — ' + detail : ''}`);
const eq = (name, a, b) =>
  ok(name, Object.is(a, b), `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const section = (t) => console.log(`\n── ${t}`);

// ------------------------------------------------------------------ 账号

section('1. 建账号');

const A = props.create({ slug: 'angkor', name: '吴哥大酒店' });
const B = props.create({ slug: 'mekong', name: '湄公河酒店' });

const boss = auth.createUser({ username: 'Boss', password: 'sunrise-2026', role: 'platform' });
const mgrA = auth.createUser({ username: 'anna', password: 'angkor-front-1', role: 'manager', propertyId: A.id });
const deskA = auth.createUser({ username: 'desk01', password: 'desk-shift-am', role: 'desk', propertyId: A.id });

eq('用户名存成小写', boss.username, 'boss');
eq('平台账号不属于任何一家', boss.propertyId, null);
eq('前台属于 A 店', deskA.propertyId, A.id);

const bad = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.message;
  }
};

ok('**太短的密码建不了**', bad(() => auth.createUser({ username: 'x1', password: 'abc', role: 'desk', propertyId: A.id })) !== null);
ok('太常见的密码建不了', bad(() => auth.createUser({ username: 'weak1', password: 'password', role: 'desk', propertyId: A.id })) !== null);
ok('**重名建不了**', bad(() => auth.createUser({ username: 'anna', password: 'another-one-1', role: 'desk', propertyId: B.id })) !== null);
ok('酒店角色必须带酒店', bad(() => auth.createUser({ username: 'nohome', password: 'no-home-here', role: 'manager' })) !== null);

// ------------------------------------------------------------------ 登录

section('2. 登录');

ok('对的密码进得来', auth.authenticate('anna', 'angkor-front-1') !== null);
ok('**错的密码进不来**', auth.authenticate('anna', 'angkor-front-2') === null);
ok('大小写不敏感的是用户名，不是密码', auth.authenticate('ANNA', 'angkor-front-1') !== null);

auth.setActive(deskA.id, false);
ok('**停用的账号进不来**', auth.authenticate('desk01', 'desk-shift-am') === null);
auth.setActive(deskA.id, true);
ok('启用回来又能进', auth.authenticate('desk01', 'desk-shift-am') !== null);

// ------------------------------------------------------------------ 权限

section('3. 角色管得着什么');

const can = (role, method, url) => auth.allowed(role, method, url);

eq('平台什么都行', can('platform', 'POST', '/api/admin/properties'), true);
eq('**酒店管理员碰不到别家酒店那一摊**', can('manager', 'POST', '/api/admin/properties'), false);
eq('**酒店管理员碰不到面板**', can('manager', 'POST', '/api/admin/panels'), false);
eq('酒店管理员管得了自己店里的设置', can('manager', 'POST', '/api/admin/branding'), true);
eq('酒店管理员管得了收款', can('manager', 'POST', '/api/admin/pay/channel'), true);

eq('前台看得了房间表', can('desk', 'GET', '/api/admin/rooms'), true);
eq('前台带查询串也认得出来', can('desk', 'GET', '/api/admin/rooms?property=2'), true);
eq('前台改得了房间号', can('desk', 'POST', '/api/admin/devices/abc123'), true);
eq('前台办得了入住', can('desk', 'POST', '/api/admin/rooms/301/checkin'), true);
eq('前台改得了订单状态', can('desk', 'POST', '/api/admin/service/order/7'), true);

eq('**前台改不了收款**', can('desk', 'POST', '/api/admin/pay/channel'), false);
eq('**前台碰不了成人板块**', can('desk', 'POST', '/api/admin/adult'), false);
eq('**前台给不了某个房间成人权限**', can('desk', 'POST', '/api/admin/adult/device'), false);
eq('**前台改不了菜单价格**', can('desk', 'POST', '/api/admin/service/item'), false);
eq('**前台换不了首页背景**', can('desk', 'POST', '/api/admin/home/background'), false);
eq('**前台建不了账号**', can('desk', 'POST', '/api/admin/users'), false);
eq('**前台看不了操作记录**', can('desk', 'GET', '/api/admin/audit'), false);
eq('**前台传不了文件**', can('desk', 'POST', '/api/admin/upload'), false);

// 白名单是「默认不给」：以后新加的接口，前台自动够不着。
eq('**以后新加的接口，前台默认够不着**', can('desk', 'POST', '/api/admin/something-new'), false);

// ------------------------------------------------------------------ 会话

section('4. 会话');

const ticket = auth.startSession({ userId: mgrA.id, role: 'manager', propertyId: A.id }, { label: 'test' });
const who = auth.resolveSession(ticket);
eq('票换得回身份', who?.username, 'anna');
eq('身份里带着是哪一家', who?.propertyId, A.id);
eq('**乱猜的票换不到东西**', auth.resolveSession('not-a-real-ticket'), null);

auth.endSession(ticket);
eq('**退出之后那张票立刻作废**', auth.resolveSession(ticket), null);

const t2 = auth.startSession({ userId: mgrA.id, role: 'manager', propertyId: A.id });
const t3 = auth.startSession({ userId: mgrA.id, role: 'manager', propertyId: A.id });
eq('一个人可以有好几张票（手机 + 电脑）', auth.sessionsOf(mgrA.id).length, 2);
auth.setPassword(mgrA.id, 'angkor-front-3');
eq('**改完密码，之前发出去的票全作废**', auth.resolveSession(t2), null);
eq('另一张也一样', auth.resolveSession(t3), null);

const t4 = auth.startSession({ userId: deskA.id, role: 'desk', propertyId: A.id });
auth.setActive(deskA.id, false);
eq('**停用账号，他手里的票当场失效**', auth.resolveSession(t4), null);
auth.setActive(deskA.id, true);

// ------------------------------------------------------------------ 限速

section('5. 登录试错限速');

const keys = ['ip:203.0.113.7'];
eq('一开始不用等', auth.lockedFor(keys), 0);
for (let i = 0; i < 4; i++) auth.noteFail(keys);
eq('**错四次还能继续试**（前台手滑是常事）', auth.lockedFor(keys), 0);
auth.noteFail(keys);
ok('**错五次开始要等**', auth.lockedFor(keys) > 0);
const first = auth.lockedFor(keys);
for (let i = 0; i < 4; i++) auth.noteFail(keys);
ok('**错得越多等得越久**', auth.lockedFor(keys) > first);
auth.clearFail(keys);
eq('进对了就清零', auth.lockedFor(keys), 0);

// ------------------------------------------------------------ 操作记录

section('6. 操作记录');

auth.record({
  who: { userId: mgrA.id, username: 'anna', role: 'manager' },
  method: 'POST',
  url: '/api/admin/adult/device?property=1',
  body: { deviceId: 'abc', allowed: true },
  propertyId: A.id,
  status: 200,
});
auth.record({
  who: { userId: boss.id, username: 'boss', role: 'platform' },
  method: 'POST',
  url: '/api/admin/pay/channel',
  body: { mchNo: '123', secret: 'hunter2' },
  propertyId: B.id,
  status: 200,
});
auth.record({
  who: { userId: mgrA.id, username: 'anna', role: 'manager' },
  method: 'GET',
  url: '/api/admin/rooms',
  body: null,
  propertyId: A.id,
  status: 200,
});
auth.record({
  who: { userId: mgrA.id, username: 'anna', role: 'manager' },
  method: 'POST',
  url: '/api/admin/branding',
  body: { color: '#fff' },
  propertyId: A.id,
  status: 400,
});

const allRows = auth.auditList(null);
eq('**读操作不记**（只记了两笔写）', allRows.length, 2);
eq('A 店只看得见自己那一笔', auth.auditList(A.id).length, 1);
eq('记得下是谁', auth.auditList(A.id)[0].username, 'anna');
ok('记得下动了什么', auth.auditList(A.id)[0].summary.includes('deviceId=abc'));

const payRow = auth.auditList(B.id)[0];
ok('**密钥只记名字不记值**', payRow.summary.includes('secret=***') && !payRow.summary.includes('hunter2'));

// ------------------------------------------------------------------ 中继

section('7. 中继不是开放代理');

/*
 * 中继会替浏览器去取上游的分片。一个 token 只该打开它自己那条流的播放列表
 * 指到的那几个来源 —— 否则拿着 token 就能让服务器替你去取任意地址，内网也行。
 *
 * 原来的检查是 `origins.size && !origins.has(...)`：token 刚发出来、主播放
 * 列表还没取过的时候白名单是空的，这一条就等于没有。
 */
{
  const { default: Fastify } = await import('fastify');
  const relay = await import('../src/relay.js');
  const app = Fastify({ routerOptions: { maxParamLength: 4000 } });
  relay.registerRelay(app);
  await app.ready();

  const enc = (u) => Buffer.from(u, 'utf8').toString('base64url');
  const hit = async (token, target) =>
    (await app.inject({ method: 'GET', url: `/hls/${token}/u/${enc(target)}` })).statusCode;

  const token = relay.mint('http://upstream.example.test/live/1.m3u8');

  eq('**还没取过播放列表，拿它去够内网 → 403**', await hit(token, 'http://127.0.0.1:19090/api/sources'), 403);
  eq('**够云主机的元数据地址 → 403**', await hit(token, 'http://169.254.169.254/computeMetadata/v1/'), 403);
  eq('**连它自己那条流的来源也得先经过播放列表登记**', await hit(token, 'http://upstream.example.test/seg1.ts'), 403);
  eq('不认识的 token → 404', await hit('0'.repeat(32), 'http://upstream.example.test/seg1.ts'), 404);
  eq('不是 http(s) → 400', await hit(token, 'file:///etc/passwd'), 400);

  /*
   * 反过来也要证明：**正常看电视的那条路没被堵死**。
   * 起一个本地的假上游，走一遍「主播放列表 → 改写 → 分片」。
   */
  const { createServer } = await import('node:http');
  const upstream = createServer((req, res) => {
    if (req.url === '/live/1.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nseg1.ts\n');
    }
    if (req.url === '/live/seg1.ts') {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      return res.end(Buffer.from([0x47, 0x40, 0x00, 0x10]));
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const port = upstream.address().port;

  const t2 = relay.mint(`http://127.0.0.1:${port}/live/1.m3u8`);
  const index = await app.inject({ method: 'GET', url: `/hls/${t2}/index.m3u8` });
  eq('主播放列表取得到', index.statusCode, 200);
  const segLine = index.body.split('\n').find((l) => l.includes('/u/'));
  ok('**分片地址被改写成走中继**', Boolean(segLine), index.body.slice(0, 200));
  if (segLine) {
    const seg = await app.inject({ method: 'GET', url: segLine.trim() });
    eq('**改写之后的分片取得到（来源已经在播放列表那一步登记过）**', seg.statusCode, 200);
    eq('取回来的是原样的字节', seg.rawPayload?.[0], 0x47);
  }
  eq(
    '**同一个 token 去够别的来源，照样 403**',
    await hit(t2, 'http://127.0.0.1:1/other'),
    403,
  );

  // 先把长连接断干净再关 —— 不然 Windows 上 process.exit 时 libuv 会断言失败，
  // 结果全绿、退出码却不稳。
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
  await app.close();
}

// ------------------------------------------------------------------ 结果

console.log('\n' + '─'.repeat(52));
if (!fails.length) {
  console.log(`全部通过：${passed} 项`);
} else {
  console.log(`通过 ${passed} 项，失败 ${fails.length} 项：\n`);
  for (const f of fails) console.log('  ✗ ' + f);
}
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* windows 上库还占着，删不掉就算了 —— 临时目录本来就是一次性的 */
}
// 不用 process.exit()：中继那一节用 fetch 连过本地上游，连接池还在收尾，
// 在 Windows 上强退会让 libuv 断言失败 —— 结果全绿、退出码却是 127。
// 设好退出码，让事件循环自己走完。
process.exitCode = fails.length ? 1 : 0;
