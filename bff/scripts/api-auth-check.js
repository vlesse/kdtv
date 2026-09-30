/**
 * 后台权限的**接口层**自检 —— 真的起一个服务，真的发 HTTP。
 *
 *   node scripts/api-auth-check.js
 *
 * 和 auth-check.js 的分工：那边查规则本身（角色能不能、票活不活），
 * 这边查**规则有没有真的挂在路由前面**。两者差的正是「前台点不到」
 * 和「前台调不到」之间那道缝 —— 而只有后者才是权限。
 *
 * 所以这里一律走网络：起服务、登录拿票、拿着票去撞那些他不该进的门。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'kdtv-apiauth-'));
const PORT = 9400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'check-token-' + Math.random().toString(36).slice(2, 10);

let passed = 0;
const fails = [];
const ok = (name, cond, detail) =>
  cond ? passed++ : fails.push(`${name}${detail ? ' — ' + detail : ''}`);
const eq = (name, a, b) =>
  ok(name, Object.is(a, b), `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const section = (t) => console.log(`\n── ${t}`);

let stderr = '';
const startServer = (extraEnv = {}) => {
  const c = spawn(process.execPath, [join(here, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      ...extraEnv,
      DB_FILE: join(dir, 'check.db'),
      MEDIA_DIR: join(dir, 'media'),
      ADMIN_TOKEN: TOKEN,
      PORT: String(PORT),
      LOG_LEVEL: 'silent',
      // 开机报到的新建限速压小，第 10 节才测得出来（线上是 300/小时）。
      NEW_DEVICES_PER_HOUR: '8',
      // 这套自检要能「激活」盒子，所以给一条平台默认线路 —— 线上就是这样配的，
      // 也正是这样，「重启把陌生盒子扫进第一家」才会变成自动激活（第 13 节）。
      DEFAULT_LINE_USER: 'platform-line',
      DEFAULT_LINE_PASS: 'platform-pass',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  c.stderr.on('data', (b) => (stderr += b.toString()));
  return c;
};
let child = startServer();

/** 同一个库、同一个端口，把服务停掉再起来 —— 测「重启之后」的行为。 */
async function restartServer(extraEnv = {}) {
  const old = child;
  await new Promise((r) => {
    old.once('exit', r);
    old.kill();
  });
  child = startServer(extraEnv);
  return waitUp();
}

function stop(code) {
  child.kill();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows 上库可能还占着 */
  }
  process.exit(code);
}

/** 等服务起来。起不来就直接说，别让后面几十条都失败一遍。 */
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      /* 还没起 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 有的回空 */
  }
  return { status: res.status, data };
};

if (!(await waitUp())) {
  console.log('服务没起来：\n' + stderr.slice(0, 800));
  stop(1);
}

// ------------------------------------------------------------ 没凭据

section('1. 没凭据一律进不去');

for (const [m, p] of [
  ['GET', '/api/admin/state'],
  ['GET', '/api/admin/rooms'],
  ['GET', '/api/admin/users'],
  ['POST', '/api/admin/adult'],
  ['GET', '/api/device/list'],
  ['POST', '/api/device/bind'],
]) {
  const r = await call(m, p);
  eq(`**${m} ${p} 没带凭据**`, r.status, 401);
}

eq('乱猜一个票也是 401', (await call('GET', '/api/admin/me', { token: 'nope-nope' })).status, 401);

// ------------------------------------------------------------ 登录

section('2. 登录换票');

const boss = await call('POST', '/api/admin/login', { body: { token: TOKEN } });
eq('老口令登录得了', boss.status, 200);
ok('**换回来的是票，不是原口令**', Boolean(boss.data?.session) && boss.data.session !== TOKEN);
const BOSS = boss.data.session;

eq('票用得了', (await call('GET', '/api/admin/me', { token: BOSS })).status, 200);
eq('老口令本身也还能直接用（保底钥匙）', (await call('GET', '/api/admin/me', { token: TOKEN })).status, 200);

// ------------------------------------------------------------ 建店建人

section('3. 建两家店、三个账号');

await call('POST', '/api/admin/properties', { token: BOSS, body: { slug: 'angkor', name: 'A 店' } });
await call('POST', '/api/admin/properties', { token: BOSS, body: { slug: 'mekong', name: 'B 店' } });

const mk = (username, role, property) =>
  call('POST', `/api/admin/users${property ? '?property=' + property : ''}`, {
    token: BOSS,
    body: { username, password: username + '-pass-2026', role },
  });

eq('建 A 店管理员', (await mk('anna', 'manager', 1)).status, 200);
eq('建 A 店前台', (await mk('desk01', 'desk', 1)).status, 200);
eq('建 B 店前台', (await mk('bob', 'desk', 2)).status, 200);
eq('**弱密码建不了**', (await call('POST', '/api/admin/users?property=1', {
  token: BOSS,
  body: { username: 'weak', password: '123', role: 'desk' },
})).status, 400);

const login = async (username) =>
  (await call('POST', '/api/admin/login', { body: { username, password: username + '-pass-2026' } }))
    .data?.session;

const ANNA = await login('anna');
const DESK = await login('desk01');
ok('管理员登录拿得到票', Boolean(ANNA));
ok('前台登录拿得到票', Boolean(DESK));

// ------------------------------------------------------------ 前台

section('4. 前台够不着的门（拿着他自己的票去撞）');

for (const [m, p, body] of [
  ['GET', '/api/admin/users'],
  ['GET', '/api/admin/audit'],
  ['GET', '/api/admin/pay'],
  ['POST', '/api/admin/pay/channel', { mchNo: 'x' }],
  ['POST', '/api/admin/adult', { enabled: true }],
  ['POST', '/api/admin/adult/device', { deviceId: 'x', allowed: true }],
  ['POST', '/api/admin/service/item', { name: { en: 'x' } }],
  ['POST', '/api/admin/branding', { color: '#fff' }],
  ['POST', '/api/admin/home/background', { type: 'image', url: '/x.jpg' }],
  ['POST', '/api/admin/tv', { template: 'live' }],
  ['GET', '/api/admin/panels'],
  ['GET', '/api/admin/properties'],
]) {
  const r = await call(m, p, { token: DESK, body });
  eq(`**前台 ${m} ${p}**`, r.status, 403);
}

section('5. 前台该能做的还是能做');

eq('看房间表', (await call('GET', '/api/admin/rooms', { token: DESK })).status, 200);
eq('看订单', (await call('GET', '/api/admin/service', { token: DESK })).status, 200);
eq('建房间', (await call('POST', '/api/admin/rooms', { token: DESK, body: { roomId: '301' } })).status, 200);
eq('办入住', (await call('POST', '/api/admin/rooms/301/checkin', { token: DESK, body: { guestName: '张三' } })).status, 200);
eq('看总览要的那份数据', (await call('GET', '/api/admin/state', { token: DESK })).status, 200);

/*
 * 填房间号和换线路是**同一条接口**（同一个 body 里的不同字段）。
 * 白名单放行的是前者，所以后者必须在路由里剥掉 —— 否则一个会按 F12 的
 * 前台可以把某间房换成别的片单，或者把盒子解绑。
 */
{
  // 先弄一台盒子出来：开机报到（这一条本来就不需要凭据），再由平台划给 A 店。
  await fetch(BASE + '/api/device/hello', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'check-box-1' }),
  });
  await call('POST', '/api/admin/devices/check-box-1?property=1', {
    token: BOSS,
    body: { roomId: '101', lineUser: 'house-line', linePass: 'house-pass' },
  });

  const boxes = (await call('GET', '/api/admin/rooms', { token: DESK })).data.devices ?? [];
  if (boxes.length) {
    const id = boxes[0].deviceId;
    const before = boxes[0].line;
    await call('POST', `/api/admin/devices/${id}`, {
      token: DESK,
      body: { roomId: '302', lineUser: 'someone-elses-line', linePass: 'x' },
    });
    const after = ((await call('GET', '/api/admin/rooms', { token: DESK })).data.devices ?? []).find(
      (d) => d.deviceId === id,
    );
    eq('前台填得了房间号', after?.roomId, '302');
    eq('**但线路没被他换掉**', after?.line ?? null, before ?? null);
  } else {
    ok('（这套环境里没有盒子，线路那一条跳过）', true);
  }
}

// ------------------------------------------------------------ 跨店

section('6. A 店的人碰不到 B 店');

const bobId = (await call('GET', '/api/admin/users?property=2', { token: BOSS })).data.users.find(
  (u) => u.username === 'bob',
).id;

eq('**A 店管理员改不了 B 店账号的密码**', (await call('POST', `/api/admin/users/${bobId}`, {
  token: ANNA,
  body: { password: 'hijacked-pass-1' },
})).status, 403);
eq('**A 店管理员删不掉 B 店的账号**', (await call('DELETE', `/api/admin/users/${bobId}`, { token: ANNA })).status, 403);
eq('**酒店管理员建不了平台账号**', (await call('POST', '/api/admin/users', {
  token: ANNA,
  body: { username: 'sneaky', password: 'sneaky-pass-1', role: 'platform' },
})).status, 403);
eq('bob 的密码没被改掉', Boolean(await login('bob')), true);

eq('**酒店管理员开不了新店**', (await call('POST', '/api/admin/properties', {
  token: ANNA,
  body: { slug: 'x', name: 'x' },
})).status, 403);
eq('**酒店管理员碰不了面板**', (await call('GET', '/api/admin/panels', { token: ANNA })).status, 403);

// A 店管理员问账号列表，只该看见自己这一家的
const annaUsers = await call('GET', '/api/admin/users', { token: ANNA });
eq('A 店管理员只看得见自己这一家的账号', annaUsers.data.users.every((u) => u.propertyId === 1), true);

// ------------------------------------------------------------ 会话

section('7. 退出与停用');

eq('退出之前票是好的', (await call('GET', '/api/admin/me', { token: DESK })).status, 200);
await call('POST', '/api/admin/logout', { token: DESK });
eq('**退出之后那张票当场作废**', (await call('GET', '/api/admin/me', { token: DESK })).status, 401);

const DESK2 = await login('desk01');
const deskId = (await call('GET', '/api/admin/users?property=1', { token: BOSS })).data.users.find(
  (u) => u.username === 'desk01',
).id;
await call('POST', `/api/admin/users/${deskId}`, { token: BOSS, body: { active: false } });
eq('**停用账号，他手里的票立刻不认**', (await call('GET', '/api/admin/me', { token: DESK2 })).status, 401);
eq('停用之后也登不进来', (await login('desk01')) ?? null, null);

// ------------------------------------------------------------ 记录

section('8. 操作记录');

const audit = await call('GET', '/api/admin/audit?property=1', { token: BOSS });
ok('记下了前台办的那次入住', audit.data.rows.some((r) => r.path.includes('/checkin') && r.username === 'desk01'));
ok('**没记读操作**', audit.data.rows.every((r) => r.method !== 'GET'));
ok('**密码不入库**', audit.data.rows.every((r) => !String(r.summary).includes('pass-2026')));

// ------------------------------------------------------------ 编码绕过

section('9. 把路径编码一下也绕不过门卫');

/*
 * 路由器匹配之前会解开百分号编码：`/api/%61dmin/rooms` 在它眼里就是
 * `/api/admin/rooms`。门卫要是拿原始 URL 去比前缀，这一类写法就直接漏过去。
 *
 * 真出过：不带任何凭据列出所有盒子、把任意一台改到任意线路和房间。
 * 所以这里挨个拿编码过的写法去撞，**每一种都得是 401/403，不能是 200**。
 */
const sneaky = [
  ['GET', '/api/%61dmin/properties'],
  ['GET', '/%61pi/admin/properties'],
  ['GET', '/api/%61dmin/rooms?property=1'],
  ['GET', '/api/admin/%72ooms?property=1'],
  ['GET', '/api/devic%65/list'],
  ['GET', '/api/device/%6cist'],
  ['POST', '/api/devic%65/bind', { deviceId: 'check-box-1', lineUser: 'hijack', linePass: 'x', roomId: '666' }],
  ['POST', '/api/%61dmin/users', { username: 'sneak', password: 'sneak-pass-2026', role: 'platform' }],
];
for (const [m, p, body] of sneaky) {
  const r = await call(m, p, { body });
  ok(`**没凭据 ${m} ${p}**`, r.status === 401, `实际 ${r.status}`);
}

// 盒子真的没被改掉，账号也真的没建出来
const box = ((await call('GET', '/api/admin/rooms?property=1', { token: BOSS })).data.devices ?? []).find(
  (d) => d.deviceId === 'check-box-1',
);
ok('**编码过的 bind 没能改掉那台盒子的线路**', box?.line !== 'hijack', `线路变成了 ${box?.line}`);
const sneakLogin = await call('POST', '/api/admin/login', {
  body: { username: 'sneak', password: 'sneak-pass-2026' },
});
ok('**没能凭空建出一个平台账号**', !sneakLogin.data?.session);

// 登录了的人也一样：前台用编码写法去够收款，管理员用编码写法去够平台那一摊。
await call('POST', `/api/admin/users/${deskId}`, { token: BOSS, body: { active: true } });
const DESK3 = await login('desk01');
for (const [who, token, m, p] of [
  ['前台', DESK3, 'GET', '/api/admin/%70ay'],
  ['前台', DESK3, 'POST', '/api/admin/%61dult'],
  ['前台', DESK3, 'GET', '/api/admin/%75sers'],
  ['管理员', ANNA, 'GET', '/api/admin/%70roperties'],
  ['管理员', ANNA, 'GET', '/api/admin/%70anels'],
]) {
  const r = await call(m, p, { token, body: m === 'POST' ? { enabled: true } : undefined });
  ok(`**${who} ${m} ${p}**`, r.status === 403, `实际 ${r.status}`);
}

// ------------------------------------------------------------ 开机报到

section('10. 开机报到：唯一一条不要凭据就能写库的接口');

const helloRaw = (body) =>
  fetch(BASE + '/api/device/hello', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.status);

for (const [label, id] of [
  ['空的', ''],
  ['一个对象', { $gt: '' }],
  ['一个数组', ['a', 'b']],
  ['太长', 'x'.repeat(200)],
  ['带斜杠', '../../etc/passwd'],
  ['带空格和尖括号', '<script>x</script>'],
]) {
  eq(`**设备号是${label} → 400**`, await helloRaw({ deviceId: id }), 400);
}
eq('正常的 ANDROID_ID 收', await helloRaw({ deviceId: 'a1b2c3d4e5f60718' }), 200);
eq('浏览器生成的 web-xxxx 也收', await helloRaw({ deviceId: 'web-k3j2h1g0' }), 200);
eq('MAC 格式怪就当没给，不拦开机', await helloRaw({ deviceId: 'a1b2c3d4e5f60719', mac: { bad: 1 } }), 200);

// 新建限速：同一来源连着刷新设备号，到上限之后就是 429 —— 而且之后不会再放行
const statuses = [];
for (let i = 0; i < 12; i++) statuses.push(await helloRaw({ deviceId: `flood-${i}-${Date.now()}` }));
const first429 = statuses.indexOf(429);
ok('**连着刷新设备号，会被限速**', first429 !== -1, `一路都是 ${statuses.join(',')}`);
ok('限速之后不会再放行新的', first429 === -1 || statuses.slice(first429).every((s) => s === 429));
eq('**已经认识的盒子不受限速影响**', await helloRaw({ deviceId: 'check-box-1' }), 200);

// ------------------------------------------------------------ 安全响应头

section('11. 每个响应都带安全头');

// 原来一个都没有。后台是能改东西的页面，被别人嵌进去诱导点击就是点击劫持。
for (const p of ['/api/health', '/admin/', '/desk/', '/api/admin/me']) {
  const r = await fetch(BASE + p);
  eq(`${p} 不许被嵌（X-Frame-Options）`, r.headers.get('x-frame-options'), 'DENY');
  eq(`${p} 不许浏览器猜类型（nosniff）`, r.headers.get('x-content-type-options'), 'nosniff');
}

// ------------------------------------------------------------ 错误怎么说

section('12. 出错的时候说人话、状态码说实话');

// 这套自检不接面板，频道表一定取不到 —— 正好拿来测「上游连不上」。
{
  const r = await fetch(BASE + '/api/channels', { headers: { 'X-Device-Id': 'check-box-1' } });
  const body = await r.json().catch(() => ({}));
  eq('**面板连不上是 502，不是 500**', r.status, 502);
  ok('**不把内部异常原样回给调用方**', !/fetch failed|ENOTFOUND|getaddrinfo/i.test(JSON.stringify(body)), JSON.stringify(body));
}
{
  const r = await fetch(BASE + '/api/device/hello', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  const body = await r.json().catch(() => ({}));
  eq('坏 JSON 是 400', r.status, 400);
  ok(
    '**人话在 error 字段里（三个客户端读的都是它），不是一句 "Bad Request"**',
    typeof body.error === 'string' && body.error !== 'Bad Request' && body.error.length > 10,
    JSON.stringify(body),
  );
}

// ------------------------------------------------------------ 重启

section('13. 服务重启不会把陌生盒子变成激活的');

/*
 * 真出过：启动迁移「把没归属的盒子都归第一家」每次启动都跑。谁拿浏览器打开
 * 电视界面留下的那台盒子，重启一次就进了第一家，下次报到按第一家拿到默认
 * 线路 —— 没人配对就激活了。每次部署都扫一遍。
 */
{
  const helloJson = async (id) =>
    (await fetch(BASE + '/api/device/hello', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: id }),
    })).json();

  // 第 10 节把「同一来源每小时新建几台」刷满了；那张表在内存里，重启一次就清了。
  ok('先重启一次，清掉第 10 节刷满的新建限速', await restartServer(), stderr.slice(-400));

  const before = await helloJson('stray-browser-9');
  eq('陌生盒子第一次来：没激活', before.activated, false);
  ok('陌生盒子第一次来：有配对码', /^\d{6}$/.test(String(before.pairingCode)));

  ok('服务重启得起来', await restartServer(), stderr.slice(-400));

  const after = await helloJson('stray-browser-9');
  eq('**重启之后它还是没激活**', after.activated, false);
  ok('**重启之后它还有配对码**（没被扫进哪一家）', /^\d{6}$/.test(String(after.pairingCode)), JSON.stringify(after));
  eq(
    '**拿它去要频道表，还是进不去**',
    (await fetch(BASE + '/api/channels', { headers: { 'X-Device-Id': 'stray-browser-9' } })).status,
    403,
  );
  eq('配好的盒子重启之后照样能用', (await call('GET', '/api/admin/me', { token: BOSS })).status, 200);
}

// ------------------------------------------------------------ 设备密钥

section('14. 设备密钥：光知道设备号冒充不了一台盒子');

/*
 * 原来盒子是谁只看它报上来的设备号，而设备号印在电视的「关于」页上、后台
 * 表里也有 —— 谁知道设备号谁就能冒充这台盒子看电视、拿带线路口令的播放地址、
 * 以那间房的名义点餐、看见住客姓名。
 */
{
  const K = (c) => c.repeat(64); // 64 位十六进制：'a' * 64 这种
  const as = async (method, path, { id, key, body } = {}) => {
    const r = await fetch(BASE + path, {
      method,
      headers: {
        ...(id ? { 'X-Device-Id': id } : {}),
        ...(key ? { 'X-Device-Key': key } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await r.json();
    } catch {
      /* 空 */
    }
    return { status: r.status, data };
  };
  const hi = (id, key, extra = {}) => as('POST', '/api/device/hello', { id, key, body: { deviceId: id, ...extra } });

  // --- 一台新盒子：第一次报到认下钥匙，配好之后就只认这把
  const first = await hi('dk-box-1', K('a'));
  eq('新盒子第一次来：没激活（还没配）', first.data?.activated, false);
  await call('POST', '/api/admin/devices/dk-box-1?property=1', { token: BOSS, body: { roomId: '501' } });
  await call('POST', '/api/admin/rooms/501/checkin?property=1', { token: BOSS, body: { guestName: '王五' } });
  eq('配好之后带着自己的钥匙：激活', (await hi('dk-box-1', K('a'))).data?.activated, true);
  eq('带着自己的钥匙要状态 → 200', (await as('GET', '/api/device/state', { id: 'dk-box-1', key: K('a') })).status, 200);

  eq('**只报设备号、不带钥匙 → 401**', (await as('GET', '/api/device/state', { id: 'dk-box-1' })).status, 401);
  eq('**带一把别的钥匙 → 401**', (await as('GET', '/api/device/state', { id: 'dk-box-1', key: K('b') })).status, 401);
  eq('**拿别的钥匙要播放地址 → 401**', (await as('GET', '/api/play/1', { id: 'dk-box-1', key: K('b') })).status, 401);
  eq('**拿别的钥匙下单 → 401**', (await as('POST', '/api/service/order', {
    id: 'dk-box-1', key: K('b'), body: { items: [{ id: 1, qty: 1 }] },
  })).status, 401);

  // --- 拿着别的钥匙来报到：什么都不告诉它，只给一个码
  const imp = await hi('dk-box-1', K('b'));
  eq('**别的钥匙来报到：不激活**', imp.data?.activated, false);
  eq('给的是「请前台重新确认」', imp.data?.rekey, true);
  ok('有一个六位的码', /^\d{6}$/.test(String(imp.data?.pairingCode)), JSON.stringify(imp.data));
  ok(
    '**回给它的东西里没有房间、住客、酒店**',
    !/王五|501|A 店|platform-line/.test(JSON.stringify(imp.data)),
    JSON.stringify(imp.data),
  );
  eq('同一把钥匙再来，码不变（电视重启、按刷新，屏幕上的码不能跳）',
    (await hi('dk-box-1', K('b'))).data?.pairingCode, imp.data?.pairingCode);
  eq('**真的那台盒子不受影响，照样能用**',
    (await as('GET', '/api/device/state', { id: 'dk-box-1', key: K('a') })).status, 200);

  const home = await as('GET', '/api/app/home', { id: 'dk-box-1', key: K('b') });
  ok('拿别的钥匙问首页配置：不告诉它是哪家酒店', !/A 店/.test(JSON.stringify(home.data)), JSON.stringify(home.data).slice(0, 200));

  // --- 前台对着码确认
  const deskTicket = await login('desk01');
  const bobTicket = await login('bob');
  eq('码不对 → 400', (await call('POST', '/api/admin/devices/dk-box-1/rekey', {
    token: deskTicket, body: { code: '000000' },
  })).status, 400);
  eq('**别家的前台确认不了这一家的盒子**', (await call('POST', '/api/admin/devices/dk-box-1/rekey', {
    token: bobTicket, body: { code: imp.data?.pairingCode },
  })).status, 404);
  const listed = (await call('GET', '/api/admin/rooms', { token: deskTicket })).data.devices.find((d) => d.deviceId === 'dk-box-1');
  eq('后台房间表里看得见「有电视在等确认」', listed?.rekeyPending > 0, true);
  eq('**这一家的前台照着码确认 → 200**', (await call('POST', '/api/admin/devices/dk-box-1/rekey', {
    token: deskTicket, body: { code: imp.data?.pairingCode },
  })).status, 200);
  eq('确认之后新钥匙能用', (await as('GET', '/api/device/state', { id: 'dk-box-1', key: K('b') })).status, 200);
  eq('**确认之后旧钥匙作废**', (await as('GET', '/api/device/state', { id: 'dk-box-1', key: K('a') })).status, 401);
  eq('同一个码用第二次 → 400', (await call('POST', '/api/admin/devices/dk-box-1/rekey', {
    token: deskTicket, body: { code: imp.data?.pairingCode },
  })).status, 400);

  // --- 老盒子：还没认下过钥匙，宽限期里照旧能用；一带钥匙来报到就认下
  await hi('dk-legacy-1'); // 不带钥匙 = 还没换上新界面的老盒子
  await call('POST', '/api/admin/devices/dk-legacy-1?property=1', { token: BOSS, body: { roomId: '502' } });
  eq('老盒子不带钥匙：宽限期里照旧 200', (await as('GET', '/api/device/state', { id: 'dk-legacy-1' })).status, 200);
  eq('老盒子换上新界面、带着钥匙来报到：激活', (await hi('dk-legacy-1', K('c'))).data?.activated, true);
  eq('**认下之后，再不带钥匙就 401**', (await as('GET', '/api/device/state', { id: 'dk-legacy-1' })).status, 401);
  eq('带着认下的钥匙照旧 200', (await as('GET', '/api/device/state', { id: 'dk-legacy-1', key: K('c') })).status, 200);

  // --- MAC 不再能让一台新设备号接管一间房
  await hi('dk-mac-old', K('d'), { mac: '3C:A0:67:00:11:22' });
  await call('POST', '/api/admin/devices/dk-mac-old?property=1', { token: BOSS, body: { roomId: '503' } });
  const thief = await hi('dk-mac-new', K('e'), { mac: '3C:A0:67:00:11:22' });
  eq('**报上别人的 MAC 的新设备号：不会被自动接进那间房**', thief.data?.activated, false);
  ok('它拿到的是普通配对码', /^\d{6}$/.test(String(thief.data?.pairingCode)));
  const hint = (await call('GET', '/api/admin/rooms?property=1', { token: BOSS })).data.devices.find((d) => d.deviceId === 'dk-mac-new');
  ok('平台在后台看得见「MAC 和 503 那台一样」的提示', /503/.test(String(hint?.macMatch)), JSON.stringify(hint));

  // --- 宽限期过了：没钥匙的老盒子也 401；但它一带钥匙来报到就会被认下（自己接回来）
  await hi('dk-legacy-2');
  await call('POST', '/api/admin/devices/dk-legacy-2?property=1', { token: BOSS, body: { roomId: '504' } });
  ok('重启成「宽限期已过」', await restartServer({ DEVICE_KEY_GRACE_UNTIL: '1' }), stderr.slice(-300));
  eq('**宽限期过了，老盒子不带钥匙 → 401**', (await as('GET', '/api/device/state', { id: 'dk-legacy-2' })).status, 401);
  eq('它带着钥匙来报到：被认下、激活', (await hi('dk-legacy-2', K('f'))).data?.activated, true);
  eq('之后带着钥匙照旧 200', (await as('GET', '/api/device/state', { id: 'dk-legacy-2', key: K('f') })).status, 200);
  eq('认下过钥匙的盒子不受宽限期影响', (await as('GET', '/api/device/state', { id: 'dk-box-1', key: K('b') })).status, 200);
}

// ------------------------------------------------------------ 结果

console.log('\n' + '─'.repeat(52));
if (!fails.length) {
  console.log(`全部通过：${passed} 项`);
} else {
  console.log(`通过 ${passed} 项，失败 ${fails.length} 项：\n`);
  for (const f of fails) console.log('  ✗ ' + f);
}
stop(fails.length ? 1 : 0);
