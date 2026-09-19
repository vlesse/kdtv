/**
 * 海报图的本地缓存。
 *
 * 点播页一屏是九百多张海报，**图不在我们手上** —— 面板给的是第三方图床的
 * 地址（img-a.example-cdn.net、img-b.example-cdn.net 这类）。盒子上的表现是：进点播要等，
 * 首屏几张图出不来，往下翻全是空框。
 *
 * 原因不是图大（一张才 20KB），是每一张都要盒子自己去跟一个陌生域名
 * 握一次手：实测单张 DNS+TCP+TLS 就去掉一秒多，而 HTTP/1.1 下浏览器对
 * 同一个域名最多开六条连接。九百张排队，客人翻页的速度远比它快。
 *
 * 所以改成：**服务端去取一次，存在本机，所有房间共用。**
 * 盒子只跟 `ott.example.com` 打交道 —— 那条连接它本来就有。
 * 加上一年的缓存头，同一台盒子第二次进点播连请求都不发。
 *
 * 地址是 `/api/art/<id>`，`id` 是原始地址的 sha1 前 20 位：
 *   · 同一张图两家酒店共用一份文件；
 *   · id 猜不出来，也就不能拿它当探针去摸我们缓存了什么；
 *   · 只有我们自己发出去过的地址才在表里，**不是一个谁都能用的转发器**
 *     （那等于把服务器借给别人去抓任意地址）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { db, now } from './db.js';

const DIR = join(config.mediaDir, 'art');
mkdirSync(DIR, { recursive: true });

/** 一张海报不该有这么大；超过的多半不是海报。 */
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 12_000;

/** 抓失败了隔多久再试。图床挂一阵子是常事，但不能每张卡片都去撞一次。 */
const RETRY_AFTER = 6 * 3600;

/** 后台预热同时抓几张。图床不是我们的，别把人家当自己的机器用。 */
const MAX_PARALLEL = 4;

/*
 * 一轮最多抓多少张。
 *
 * 解锁成人区之后那一份片库是**五千一百多部**，一口气抓完要二十分钟不停歇。
 * 这台机器两个核还要伺候直播和截图，所以切成几轮：这一轮抓一千五，
 * 十分钟后的下一次请求接着抓。客人当场看到的那几十张是现抓的，不受这个限制。
 */
const WARM_PER_RUN = 1500;

/** 多久没人看过就删。整个片库也就二三十兆，主要是防片库换了之后的陈货。 */
const KEEP_DAYS = 60;

/*
 * UA 要像浏览器。
 *
 * 和 previews.js 同一个理由：有的图床对非浏览器 UA 直接 403，
 * 那样「这张图抓不到」看着像我们的毛病，其实是被人家拦了。
 */
const UA =
  'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** 已经登记过的 id。省掉每次出列表时那九百多次写库。 */
const known = new Set(db.prepare('SELECT id FROM art_cache').all().map((r) => r.id));

const insert = db.prepare('INSERT OR IGNORE INTO art_cache (id, url, created_at) VALUES (?, ?, ?)');

const idOf = (url) => createHash('sha1').update(url).digest('hex').slice(0, 20);

/**
 * 把一个远程图片地址换成我们自己的地址。
 *
 * 不是远程 http(s) 地址的原样返回 —— 面板自己的图早就被 `xui.publicAsset`
 * 指到我们的反代上了，再包一层没有意义。
 */
export function proxy(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) return raw;

  // 已经是我们自己的地址了（面板的图早被 xui.publicAsset 指到我们的反代上），
  // 再套一层就是自己请求自己。
  if (config.publicBaseUrl && raw.startsWith(config.publicBaseUrl)) return raw;

  const id = idOf(raw);
  if (!known.has(id)) {
    insert.run(id, raw, now());
    known.add(id);
  }
  return `/api/art/${id}`;
}

function rowOf(id) {
  return db.prepare('SELECT * FROM art_cache WHERE id = ?').get(String(id ?? ''));
}

const fileOf = (row) => join(DIR, `${row.id}.${MIME_EXT[row.mime] ?? 'jpg'}`);

function onDisk(row) {
  if (!row?.mime) return null;
  const path = fileOf(row);
  try {
    const size = statSync(path).size;
    return size > 0 ? { path, bytes: size } : null;
  } catch {
    return null;
  }
}

/** 同一张图同时来十个请求，只去抓一次。 */
const inFlight = new Map();

async function download(row) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(row.url, {
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: 'image/*,*/*' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const mime = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!MIME_EXT[mime]) throw new Error(`不是图片：${mime || '没给类型'}`);

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('空文件');
    if (buf.length > MAX_BYTES) throw new Error(`太大：${buf.length}`);

    // 先写临时文件再改名：半截文件被当成缓存命中，那张图就永远是坏的。
    const path = join(DIR, `${row.id}.${MIME_EXT[mime]}`);
    const tmp = `${path}.part`;
    writeFileSync(tmp, buf);
    renameSync(tmp, path);

    db.prepare('UPDATE art_cache SET mime = ?, bytes = ?, fetched_at = ?, failed_at = NULL WHERE id = ?')
      .run(mime, buf.length, now(), row.id);
    return { path, mime, bytes: buf.length };
  } catch (err) {
    db.prepare('UPDATE art_cache SET failed_at = ? WHERE id = ?').run(now(), row.id);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拿到这张图的本地文件；没有就现抓。
 *
 * 返回 `null` 的意思是「这张图这会儿拿不到」—— 调用方回 404，电视上就是
 * 一张没有海报的卡片，和以前图床超时的表现一样，不会卡住整页。
 */
export async function ensure(id, log) {
  const row = rowOf(id);
  if (!row) return null;

  const hit = onDisk(row);
  if (hit) return { ...hit, mime: row.mime };

  // 刚失败过就别再撞。九百张卡片同时重试一个挂掉的图床，
  // 受苦的是我们自己的出口。
  if (row.failed_at && now() - row.failed_at < RETRY_AFTER) return null;

  if (!inFlight.has(row.id)) {
    inFlight.set(
      row.id,
      download(row)
        .catch((err) => {
          log?.warn({ url: row.url, err: err.message }, '海报抓取失败');
          return null;
        })
        .finally(() => inFlight.delete(row.id)),
    );
  }
  return inFlight.get(row.id);
}

/** 记一笔「有人看过」。清理靠它，写得很轻（一次 UPDATE，不读）。 */
export function touch(id) {
  db.prepare('UPDATE art_cache SET last_hit = ? WHERE id = ?').run(now(), id);
}

let warming = false;
let warmedAt = 0;

/**
 * 后台把一整批图先抓下来。
 *
 * 第一个进点播的客人会触发它，之后每个房间都是本地命中。故意慢慢抓
 * （四个并发）：这台机器两个核，还要伺候直播和截图。
 */
export async function warm(ids, log) {
  // 出一次列表就走一遍九百次 stat 没必要 —— 片库不会一分钟换一批。
  if (warming || now() - warmedAt < 600) return;
  const todo = ids.filter((id) => {
    const row = rowOf(id);
    return row && !onDisk(row) && !(row.failed_at && now() - row.failed_at < RETRY_AFTER);
  });
  // 全都有了也记一笔：下一次请求就不用再走一遍那九百次 stat。
  if (!todo.length) {
    warmedAt = now();
    return;
  }

  warming = true;
  const run = todo.slice(0, WARM_PER_RUN);
  log?.info({ n: run.length, left: todo.length - run.length }, '开始预热海报');
  let ok = 0;
  try {
    for (let i = 0; i < run.length; i += MAX_PARALLEL) {
      const batch = run.slice(i, i + MAX_PARALLEL);
      const got = await Promise.all(batch.map((id) => ensure(id, log).catch(() => null)));
      ok += got.filter(Boolean).length;
    }
  } finally {
    warming = false;
    warmedAt = now();
    log?.info({ ok, of: run.length }, '海报预热结束');
  }
}

/** 久没人看的删掉。片库换过一轮之后，旧海报就再也不会被请求了。 */
export function sweep(log) {
  const cutoff = now() - KEEP_DAYS * 86400;
  const stale = db
    .prepare('SELECT * FROM art_cache WHERE COALESCE(last_hit, fetched_at, created_at) < ?')
    .all(cutoff);

  let freed = 0;
  for (const row of stale) {
    const hit = onDisk(row);
    if (hit) {
      try {
        freed += hit.bytes;
        unlinkSync(hit.path);
      } catch {
        /* 已经不在了就算了 */
      }
    }
    db.prepare('DELETE FROM art_cache WHERE id = ?').run(row.id);
  }

  // 表里没有、盘上还在的孤儿文件（改过 id 规则、或者删表重建过）。
  try {
    for (const name of readdirSync(DIR)) {
      const id = name.split('.')[0];
      if (!rowOf(id)) {
        try {
          const p = join(DIR, name);
          freed += statSync(p).size;
          unlinkSync(p);
        } catch {
          /* 同上 */
        }
      }
    }
  } catch {
    /* 目录还没建 */
  }

  if (freed) log?.info({ files: stale.length, freed }, '清掉了没人看的海报');
  return freed;
}

/** 后台「存储」那一栏要看的数字。 */
export function stats() {
  const r = db
    .prepare('SELECT COUNT(*) n, COALESCE(SUM(bytes), 0) bytes FROM art_cache WHERE mime IS NOT NULL')
    .get();
  const pending = db.prepare('SELECT COUNT(*) n FROM art_cache WHERE mime IS NULL').get().n;
  return { cached: r.n, bytes: r.bytes, pending };
}
