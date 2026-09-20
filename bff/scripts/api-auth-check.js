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

const child = spawn(process.execPath, [join(here, '..', 'src', 'server.js')], {
  env: {
    ...process.env,
    DB_FILE: join(dir, 'check.db'),
    MEDIA_DIR: join(dir, 'media'),
    ADMIN_TOKEN: TOKEN,
    PORT: String(PORT),
    LOG_LEVEL: 'silent',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (b) => (stderr += b.toString()));

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

// ------------------------------------------------------------ 结果

console.log('\n' + '─'.repeat(52));
if (!fails.length) {
  console.log(`全部通过：${passed} 项`);
} else {
  console.log(`通过 ${passed} 项，失败 ${fails.length} 项：\n`);
  for (const f of fails) console.log('  ✗ ' + f);
}
stop(fails.length ? 1 : 0);
