// Storage layer. Uses Node's built-in SQLite so there is no native module to
// compile and nothing extra to run alongside the service.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbFile), { recursive: true });
export const db = new DatabaseSync(config.dbFile);

db.exec(`
  PRAGMA journal_mode = WAL;

  -- One row per set-top box. 'code' is the 6-digit pairing code shown on
  -- screen while the box is still unbound.
  CREATE TABLE IF NOT EXISTS devices (
    device_id     TEXT PRIMARY KEY,
    mac           TEXT,
    code          TEXT,
    room_id       TEXT,
    line_user     TEXT,
    line_pass     TEXT,
    label         TEXT,
    last_seen     INTEGER,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_devices_code ON devices(code);
  CREATE INDEX IF NOT EXISTS idx_devices_mac  ON devices(mac);

  -- Rooms are the unit the hospitality side works in. Kept deliberately
  -- thin so a real PMS can later become the source of truth.
  CREATE TABLE IF NOT EXISTS rooms (
    room_id     TEXT PRIMARY KEY,
    building    TEXT,
    floor       TEXT,
    guest_name  TEXT,
    checked_in  INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS service_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT NOT NULL,
    name_en     TEXT NOT NULL,
    name_zh     TEXT,
    name_id     TEXT,
    name_km     TEXT,
    price       REAL NOT NULL DEFAULT 0,
    currency    TEXT NOT NULL DEFAULT 'IDR',
    image       TEXT,
    available   INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id     TEXT,
    device_id   TEXT,
    items_json  TEXT NOT NULL,
    total       REAL NOT NULL DEFAULT 0,
    note        TEXT,
    status      TEXT NOT NULL DEFAULT 'new',
    created_at  INTEGER NOT NULL
  );

  -- Operator-editable runtime settings. Every key has a working default in
  -- config.js; a row here simply overrides it, so the service still boots
  -- correctly with an empty table and nothing has to be re-deployed to change
  -- a background image.
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at INTEGER NOT NULL
  );

  -- Files uploaded through the admin console. The bytes live on disk under
  -- the media directory; this is the index the console lists from.
  CREATE TABLE IF NOT EXISTS media (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT NOT NULL UNIQUE,
    original    TEXT,
    kind        TEXT NOT NULL,
    mime        TEXT,
    bytes       INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );

  -- Messages pushed to a room (or broadcast when room_id IS NULL).
  CREATE TABLE IF NOT EXISTS notices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id     TEXT,
    title       TEXT NOT NULL,
    body        TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER
  );
`);

/**
 * Columns added after a database was already in service.
 *
 * `CREATE TABLE IF NOT EXISTS` above leaves an existing table alone, so a
 * deployed box would never see a new column. Adding them here keeps a fresh
 * install and an upgraded one identical, and re-running is harmless.
 */
function addColumn(table, column, decl) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all();
  if (have.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

addColumn('service_items', 'name_km', 'TEXT');

// How long this box may watch gated content for. Set by a guest paying for a
// pass; null/0 means no pass. Irrelevant while the property itself is paid up -
// see billing.js.
addColumn('devices', 'content_until', 'INTEGER');

// Whether this box may show the restricted section at all. Off unless an
// operator turns it on for that room, which is the only safe default: a
// dormitory or a family floor should never have the section to unlock.
addColumn('devices', 'adult_allowed', 'INTEGER NOT NULL DEFAULT 0');


// ---------------------------------------------------------------- 多租户

/*
 * 一台服务器，很多家酒店。
 *
 * APK 里只有一个地址，十家酒店的盒子都打到这里，所以「这台盒子是哪家的」
 * 必须由服务端自己认出来。房间号只在一家酒店内唯一 —— A 店的 301 和 B 店的
 * 301 是两个房间，这件事必须写在主键里，不能靠调用方记得带上条件。
 *
 * 下面这段迁移对已经在跑的库是安全的、可重复执行的：第一次跑会把现有的一切
 * 归到 1 号酒店（名字取自原来的 home.propertyName），之后再跑什么都不做。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS properties (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    contact     TEXT,
    -- 这家前台自己的后台口令。存的是 scrypt 摘要，不是口令本身。
    token_hash  TEXT,
    token_salt  TEXT,
    -- 留空 = 用平台默认线路。想给某一家单独换片库就填这里。
    line_user   TEXT,
    line_pass   TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL
  );
`);

// 归属字段。加在这里而不是建表语句里，是因为这些表早就有数据了。
addColumn('devices', 'property_id', 'INTEGER');
addColumn('service_items', 'property_id', 'INTEGER');
addColumn('orders', 'property_id', 'INTEGER');
addColumn('notices', 'property_id', 'INTEGER');
// 素材也分家：A 店传的酒店照片不该出现在 B 店的素材库里。
addColumn('media', 'property_id', 'INTEGER');

/**
 * 换主键要重建表 —— SQLite 的 ALTER TABLE 改不了主键。
 *
 * `rooms.room_id` 原来是全局主键，也就是说十家酒店共用一套房间号：
 * A 店给 301 退房会把 B 店 301 的客人姓名一起清掉。必须变成
 * (property_id, room_id)。
 */
function rebuild(table, ddl, columns, fill) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!info.length) return false;
  // 已经是新结构就不动。判断依据：property_id 在不在主键里。
  if (info.some((c) => c.name === 'property_id' && c.pk > 0)) return false;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
  db.exec(ddl);
  db.exec(
    `INSERT INTO ${table} (property_id, ${columns.join(', ')})
     SELECT ${fill}, ${columns.join(', ')} FROM ${table}_old`,
  );
  db.exec(`DROP TABLE ${table}_old`);
  db.exec('PRAGMA foreign_keys = ON');
  return true;
}

const roomsRebuilt = rebuild(
  'rooms',
  `CREATE TABLE rooms (
     property_id INTEGER NOT NULL,
     room_id     TEXT NOT NULL,
     building    TEXT,
     floor       TEXT,
     guest_name  TEXT,
     checked_in  INTEGER NOT NULL DEFAULT 0,
     updated_at  INTEGER NOT NULL,
     PRIMARY KEY (property_id, room_id)
   )`,
  ['room_id', 'building', 'floor', 'guest_name', 'checked_in', 'updated_at'],
  '1',
);

/*
 * settings 同理，而且这张表的后果更直接：原来全局只有一行
 * home.propertyName，十家酒店的电视会显示同一个名字、同一张背景。
 *
 * property_id = 0 留给平台自己（后台总口令、我们自己的收款商户、默认线路），
 * 1 以上是各家酒店。
 */
const settingsRebuilt = rebuild(
  'settings',
  `CREATE TABLE settings (
     property_id INTEGER NOT NULL,
     key         TEXT NOT NULL,
     value       TEXT,
     updated_at  INTEGER NOT NULL,
     PRIMARY KEY (property_id, key)
   )`,
  ['key', 'value', 'updated_at'],
  // 后台总口令是平台的，别的都属于第一家酒店。
  `CASE WHEN key IN ('admin.token') THEN 0 ELSE 1 END`,
);

/**
 * 第一家酒店。
 *
 * 只在库里已经有东西、却还没有任何酒店的时候建 —— 也就是从单店版升级上来的
 * 那一次。全新安装什么都不建，第一家由操作员在后台自己填。
 */
/* ---------------------------------------------------------------- 旅游周边

 * 酒店周边值得去的地方。一条就是一个去处：一张图、四种语言的
 * 名字和介绍、排序、上不上架。形状故意跟 `service_items` 一样 ——
 * 后台那张表前台已经会用了，再发明一种用法没意义。
 *
 * `desc_*` 是一段纯文本，不收 HTML：这段字要显示在电视上，
 * 而电视上没有人能处理一段排版坏掉的内容。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS explore_spots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id INTEGER NOT NULL,
    name_en     TEXT NOT NULL,
    name_zh     TEXT,
    name_id     TEXT,
    name_km     TEXT,
    desc_en     TEXT,
    desc_zh     TEXT,
    desc_id     TEXT,
    desc_km     TEXT,
    image       TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
`);
// 加列和加索引要成对且索引在后 —— 旧库里 CREATE TABLE IF NOT EXISTS 不做事，
// 索引写在前面会因为找不到列而把容器弄崩（上线真炸过一次）。
db.exec('CREATE INDEX IF NOT EXISTS idx_explore_property ON explore_spots(property_id)');

/* ------------------------------------------------------------ 海报缓存

 * 点播海报的本地副本（见 src/art.js）。表里存的是「这个 id 对应哪个远程
 * 地址」，图片本身在 media/art/ 下。
 *
 * **只存我们自己发出去过的地址。** 取图那条路由查这张表，查不到就 404 ——
 * 少了这张表，`/api/art/?url=…` 那种写法等于把服务器借给外人去抓任意地址。
 *
 * `mime` 是空的表示还没抓到过；`failed_at` 有值表示上次抓失败了，
 * 隔一段时间才会再试，免得九百张卡片一起去撞一个挂掉的图床。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS art_cache (
    id         TEXT PRIMARY KEY,
    url        TEXT NOT NULL,
    mime       TEXT,
    bytes      INTEGER,
    created_at INTEGER NOT NULL,
    fetched_at INTEGER,
    failed_at  INTEGER,
    last_hit   INTEGER
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_art_seen ON art_cache(last_hit)');

/* ---------------------------------------------------------- 后台的人

 * 原来进后台只有一个共用口令，没有「谁」这个概念：前台三个人共用一个密码，
 * 出了事查不出是谁动的，人走了也没法只收回他一个人的权限。
 *
 * 四张表（细节见 src/adminauth.js）：
 *   admin_users     一人一个账号，带角色（平台 / 酒店管理员 / 前台）
 *   admin_sessions  登录换一张有期限的票，浏览器里存票不存密码
 *   admin_audit     谁、什么时候、动了哪一家的什么（只记写操作）
 *   admin_lockout   登录试错限速 —— 这个控制台挂在公网上，
 *                   原来密码是可以无限次猜的
 *
 * `admin_users.property_id` 为 NULL = 平台账号。密码是 scrypt + 每人一个盐，
 * 和酒店口令同一套做法。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id INTEGER,
    username    TEXT NOT NULL,
    pass_hash   TEXT NOT NULL,
    pass_salt   TEXT NOT NULL,
    role        TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    last_login  INTEGER
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER,
    property_id INTEGER,
    role        TEXT NOT NULL,
    label       TEXT,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER NOT NULL,
    user_id     INTEGER,
    username    TEXT,
    role        TEXT,
    property_id INTEGER,
    method      TEXT NOT NULL,
    path        TEXT NOT NULL,
    summary     TEXT
  );
  CREATE TABLE IF NOT EXISTS admin_lockout (
    key        TEXT PRIMARY KEY,
    fails      INTEGER NOT NULL DEFAULT 0,
    until      INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_user_name ON admin_users(username)');
db.exec('CREATE INDEX IF NOT EXISTS idx_admin_session_user ON admin_sessions(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_admin_audit_prop ON admin_audit(property_id, id)');

/* ------------------------------------------------------------------ 面板

 * 一台服务器可以接好几台 XUI 面板，每家酒店各自指定用哪一台。
 *
 * 两个地址必须分开，它们服务的不是同一个人：
 *   `api_base`    服务器自己拿频道列表用。可以是内网地址、可以是明文 http。
 *   `public_base` **盒子**拿视频用。盒子在酒店里，进不了内网，
 *                 而且页面是 https，所以这个必须是公网上能访问的地址。
 *                 面板自己有 https 就直接填它；没有就在 nginx 里给它开一个
 *                 反代入口（像现在的 /stream/ 那样），填那个地址。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS panels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    api_base    TEXT NOT NULL,
    public_base TEXT NOT NULL,
    note        TEXT,
    created_at  INTEGER NOT NULL
  );
`);

// 留空 = 用平台默认那台（slug 为 'default' 的）。
addColumn('properties', 'panel_id', 'INTEGER');

/*
 * 这台盒子的线路是人手指定的，开机时不要拿酒店的线路覆盖它。
 *
 * 不加这一列的后果实测过：后台给某一台单独换线路，看着改成了，
 * 盒子下次开机又被 hello() 改回去 —— 而界面上写的是「盒子重启后生效」。
 */
addColumn('devices', 'line_pinned', 'INTEGER NOT NULL DEFAULT 0');

/**
 * 把现在配置里那台面板录成第一行。
 *
 * 升级上来的库本来就在用它，只是这个地址一直只存在于环境变量里。
 * 先建这一行，所有酒店的 panel_id 留空就继续指着它，升级前后行为一致。
 */
function seedDefaultPanel() {
  if (db.prepare("SELECT COUNT(*) n FROM panels WHERE slug = 'default'").get().n > 0) return;
  db.prepare(
    'INSERT INTO panels (slug, name, api_base, public_base, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    'default',
    '默认面板',
    process.env.XUI_BASE ?? 'http://xui-ott:80',
    process.env.XUI_PUBLIC_BASE ?? 'http://localhost:9080',
    '从环境变量 XUI_BASE / XUI_PUBLIC_BASE 建的。改这一行就能换掉全平台默认的面板。',
    Math.floor(Date.now() / 1000),
  );
}

seedDefaultPanel();

function seedFirstProperty() {
  if (db.prepare('SELECT COUNT(*) n FROM properties').get().n > 0) return;

  const hasData =
    db.prepare('SELECT COUNT(*) n FROM devices').get().n > 0 ||
    db.prepare('SELECT COUNT(*) n FROM settings').get().n > 0;
  if (!hasData) return;

  const name =
    db.prepare("SELECT value FROM settings WHERE property_id = 1 AND key = 'home.propertyName'").get()
      ?.value || 'KDTV';

  db.prepare(
    'INSERT INTO properties (id, slug, name, active, created_at) VALUES (1, ?, ?, 1, ?)',
  ).run('house', name, Math.floor(Date.now() / 1000));
}

seedFirstProperty();

// 存量的盒子、菜单、订单、通知都归第一家。
if (db.prepare('SELECT COUNT(*) n FROM properties').get().n > 0) {
  const first = db.prepare('SELECT MIN(id) id FROM properties').get().id;
  for (const t of ['devices', 'service_items', 'orders', 'notices', 'media']) {
    db.prepare(`UPDATE ${t} SET property_id = ? WHERE property_id IS NULL`).run(first);
  }
}

if (roomsRebuilt || settingsRebuilt) {
  console.log('[db] 已迁移到多租户结构：rooms/settings 主键改为 (property_id, …)');
}

export const PLATFORM = 0;

export const now = () => Math.floor(Date.now() / 1000);
