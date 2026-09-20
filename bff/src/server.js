/*
 * KDTV — 酒店电视系统
 * Copyright (C) 2026 lngsuan <https://t.me/lngsuan>
 *
 * 按 GNU Affero General Public License v3.0 或更高版本发布。
 * 详见根目录的 LICENSE 和 NOTICE。**改过的版本架成网络服务给别人用，
 * 用的人就有权拿到这个版本的完整源码**（AGPL 第 13 条）。
 * 商业授权（闭源、不公开改动）另谈：https://t.me/lngsuan
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { config } from './config.js';
import { db, now } from './db.js';
import * as xui from './xui.js';
import { hello, bind, bindByCode, getDevice, listDevices, isBound } from './devices.js';
import { seedIfEmpty } from './seed.js';
import * as weather from './weather.js';
import * as settings from './settings.js';
import { registerAdmin } from './admin.js';
import { registerRelay, mint } from './relay.js';
import { registerDownload } from './download.js';
import * as pay from './pay.js';
import * as billing from './billing.js';
import * as properties from './properties.js';
import * as previews from './previews.js';
import * as explore from './explore.js';
import * as art from './art.js';
import * as adminAuth from './adminauth.js';
import { startPreviewSweeper } from './preview-sweeper.js';
import { initials } from './pinyin.js';
import { PLATFORM } from './db.js';
import * as svc from './service.js';
import * as adult from './adult.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  /*
   * The relay carries a whole upstream URL inside a path parameter, and the
   * router's default ceiling for one is 100 characters. A CDN segment URL is
   * comfortably twice that before encoding, so every segment quietly missed
   * its route and came back as a 404 from the catch-all - a stream that
   * fetched its playlist fine and then played nothing.
   */
  maxParamLength: 4000,

  /*
   * nginx terminates TLS on this host and proxies in over loopback, so without
   * this every request looks like plain http from 127.0.0.1: `req.protocol`
   * answers "http" (the installer page printed an http:// address for a site
   * that only answers https) and `req.ip` is the proxy rather than the box.
   * The value is a hop count, not an address, and that matters twice over.
   * An address does not work: the container is published on 127.0.0.1:19080
   * and reached through the docker bridge, so nginx arrives as 172.21.0.1, not
   * loopback. And `true` would be wrong even though it works: it takes the
   * left-most entry of X-Forwarded-For, which the client writes, so any box
   * could claim any IP. `1` means "one proxy in front of us" and reads the
   * entry nginx itself appended - the only one nobody downstream can forge.
   */
  trustProxy: 1,
});
await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: config.admin.maxUploadBytes, files: 1 } });

seedIfEmpty();
registerAdmin(app);
registerRelay(app);
registerDownload(app);

// ---------------------------------------------------------------- helpers

/** Resolve the calling box from its device id header and require a bound line. */
function requireLine(req, reply) {
  const deviceId = req.headers['x-device-id'];
  if (!deviceId) {
    reply.code(400).send({ error: 'missing X-Device-Id' });
    return null;
  }
  const dev = getDevice(String(deviceId));
  if (!dev || !isBound(dev)) {
    reply.code(403).send({ error: 'device not activated', deviceId });
    return null;
  }
  return dev;
}

// ---------------------------------------------------------------- device

app.post('/api/device/hello', async (req, reply) => {
  const { deviceId, mac, label } = req.body ?? {};
  if (!deviceId) return reply.code(400).send({ error: 'deviceId required' });

  const dev = hello({ deviceId, mac, label });
  const bound = isBound(dev);

  let profile = null;
  if (bound) {
    try {
      const info = await xui.authenticate(properties.lineOf(dev));
      profile = {
        status: info?.user_info?.status ?? 'Unknown',
        expiresAt: info?.user_info?.exp_date ?? null,
        maxConnections: info?.user_info?.max_connections ?? null,
      };
    } catch (err) {
      req.log.warn({ err: err.message }, 'upstream auth failed');
    }
  }

  // 房间号只在一家酒店里唯一，所以查房间必须带上酒店 —— 少了它，
  // A 店的 301 会查出 B 店 301 的客人姓名。
  const room =
    dev.room_id && dev.property_id
      ? db
          .prepare('SELECT * FROM rooms WHERE property_id = ? AND room_id = ?')
          .get(dev.property_id, dev.room_id)
      : null;

  const property = dev.property_id ? properties.find(dev.property_id) : null;

  return {
    activated: bound,
    pairingCode: bound ? null : dev.code,
    deviceId: dev.device_id,
    property: property ? { id: property.id, name: property.name } : null,
    room: room ? { id: room.room_id, guestName: room.guest_name, building: room.building } : null,
    profile,
    appVersion: config.appVersion,
    adultAvailable: bound ? adult.status(dev).available : false,
    /*
     * 旅游周边这一格要不要出现。和成人频道同一个规矩：
     * **没有内容就不告诉盒子它存在**，免得客人点进去看到一片空白。
     */
    exploreAvailable: bound && dev.property_id != null ? explore.any(dev.property_id) : false,
  };
});

/**
 * A device row as an operator may see it.
 *
 * The line password never leaves this process. An operator needs to know which
 * line a box is on and whether it is bound at all, and neither answer requires
 * handing back the credential itself - the box does not use it either, since
 * stream URLs are minted here.
 */
function publicDevice(dev) {
  if (!dev) return dev;
  const { line_pass, ...rest } = dev;
  return { ...rest, bound: Boolean(dev.line_user && line_pass) };
}

// Operator-facing pairing, behind the console token (see admin.js).
app.post('/api/device/bind', async (req, reply) => {
  const { code, deviceId, lineUser, linePass, roomId, label } = req.body ?? {};
  const payload = { lineUser, linePass, roomId, label };
  const dev = code
    ? bindByCode(String(code), payload)
    : deviceId
      ? bind(String(deviceId), payload)
      : null;
  if (!dev) return reply.code(404).send({ error: 'no device for that code/id' });
  return { ok: true, device: publicDevice(dev) };
});

app.get('/api/device/list', async (req) => ({
  devices: listDevices(req.pid ?? null).map(publicDevice),
}));

// -------------------------------------------------------------- restricted

/**
 * Whether to draw the restricted tile at all.
 *
 * Three things have to line up - the property carries the section, a PIN
 * exists, and this room is allowed it - and a box that fails any of them is
 * told simply "no", with no hint that there is anything to ask for.
 */
app.get('/api/adult/status', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;
  return { ...adult.status(dev), unlocked: adult.isUnlocked(req, dev) };
});

app.post('/api/adult/unlock', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;

  const result = adult.unlock(dev, String(req.body?.pin ?? ''));
  if (result.ok) return { ok: true, token: result.token, expiresInMs: result.expiresInMs };

  // A device that is not entitled gets the same answer as a wrong PIN would
  // eventually give it, so probing tells nobody whether a room is enabled.
  if (result.unavailable) return reply.code(403).send({ error: 'unavailable' });
  if (result.retryAfterMs) {
    return reply
      .code(429)
      .send({ error: 'locked out', retryAfterMs: result.retryAfterMs });
  }
  return reply.code(401).send({ error: 'wrong pin', remaining: result.remaining });
});

app.post('/api/adult/lock', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;
  adult.lock(req.headers['x-adult-token']);
  return { ok: true };
});

// ---------------------------------------------------------------- content

/**
 * 这台盒子此刻的权限和房间。
 *
 * 和 `hello` 的区别是**它不动 `last_seen`**。后台设备表那一列写的是
 * 「最后开机」，靠的就是 hello 一次开机只来一趟；首页每分钟问一次，
 * 要是问的是 hello，那一列就变成了「一分钟前」，等于把这个信息毁掉。
 *
 * 为什么首页要反复问：能不能看成人区、有没有周边、客人叫什么，
 * 全是前台在后台随时会改的东西。不问的话前台勾完得让客人把电视拔了重插。
 */
app.get('/api/device/state', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;

  const room =
    dev.room_id && dev.property_id
      ? db
          .prepare('SELECT * FROM rooms WHERE property_id = ? AND room_id = ?')
          .get(dev.property_id, dev.room_id)
      : null;

  return {
    adultAvailable: adult.status(dev).available,
    exploreAvailable: dev.property_id != null ? explore.any(dev.property_id) : false,
    room: room ? { id: room.room_id, guestName: room.guest_name, building: room.building } : null,
  };
});

app.get('/api/channels', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;

  const line = properties.lineOf(dev);
  const [cats, streams] = await Promise.all([
    xui.liveCategories(line),
    xui.liveStreams(line),
  ]);

  const catList = Array.isArray(cats) ? cats : [];
  const streamList = Array.isArray(streams) ? streams : [];
  const byId = new Map(catList.map((c) => [String(c.category_id), c.category_name]));

  /*
   * Restricted categories are stripped from the answer rather than flagged for
   * the app to hide. A locked box is not told what it is missing, because a
   * list it has been handed is a list it can be made to render.
   */
  const unlocked = adult.isUnlocked(req, dev);
  const adultOn = adult.adultEnabled(dev.property_id);
  const restricted = (categoryId) =>
    adultOn &&
    adult.isAdultCategory(dev.property_id, byId.get(String(categoryId ?? '')), 'live', categoryId);
  const wantPoster = settings.tvConfig(dev.property_id).channelPreview;

  const channels = streamList
    .filter((s) => unlocked || !restricted(s.category_id))
    .map((s) => ({
      id: s.stream_id,
      num: s.num,
      name: s.name,
      icon: xui.publicAsset(s.stream_icon, line),
      /*
       * 这一台此刻大概在放什么，一张静图。
       *
       * 只是查一下文件在不在，**不触发抓取** —— 这个接口一次要过 91 个频道，
       * 顺手触发的话一次开机就排出 91 个 ffmpeg。补图是扫描器的活。
       * 受限频道走不到这里：上面那个 filter 已经把它们滤掉了。
       */
      poster: wantPoster && !restricted(s.category_id) ? previews.still(line, s.stream_id) : null,
      categoryId: String(s.category_id ?? ''),
      categoryName: byId.get(String(s.category_id ?? '')) ?? 'Lainnya',
      hasArchive: Boolean(s.tv_archive),
      adult: restricted(s.category_id),
    }));

  const categories = catList
    .filter((c) => unlocked || !restricted(c.category_id))
    .map((c) => ({
      id: String(c.category_id),
      name: c.category_name,
      count: channels.filter((ch) => ch.categoryId === String(c.category_id)).length,
      adult: restricted(c.category_id),
    }))
    .filter((c) => c.count > 0)
    // Even to a room that may see them, these go last. A guest who unlocked
    // the section once should not have to scroll past it to reach the news.
    .sort((a, b) => Number(a.adult) - Number(b.adult));

  return { categories, channels };
});

app.get('/api/epg/:streamId', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;

  const raw = await xui.shortEpg(properties.lineOf(dev), req.params.streamId, 10);
  const listings = (raw?.epg_listings ?? []).map((e) => ({
    title: xui.decodeEpgText(e.title),
    description: xui.decodeEpgText(e.description),
    start: e.start_timestamp ? Number(e.start_timestamp) : null,
    stop: e.stop_timestamp ? Number(e.stop_timestamp) : null,
  }));
  return { listings };
});

/**
 * 这个频道此刻大概在放什么 —— 一张会循环的 1.5 秒动图。
 *
 * 遥控器停在哪张卡上，前端就问哪一张。**永远立刻回**：有旧图先给旧图，
 * 新的在后台抓。让遥控器等 ffmpeg 是不能接受的。
 */
/** 酒店周边值得去的地方。只有上架、而且有图的才发出去。 */
app.get('/api/explore', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;
  if (dev.property_id == null) return { spots: [] };
  return { spots: explore.published(dev.property_id) };
});

/*
 * 一张海报。
 *
 * **故意不校验设备**：<img> 不会带我们的设备头，加了鉴权图就出不来。
 * 能取到的只有我们自己发出去过的 id（sha1，猜不出来），而这些图本来就
 * 公开挂在第三方图床上 —— 这里只是把它搬到客人够得着的那条连接上。
 */
app.get('/api/art/:id', async (req, reply) => {
  const got = await art.ensure(req.params.id, req.log);
  if (!got) return reply.code(404).send({ error: 'not found' });

  art.touch(req.params.id);
  // 一年、immutable：id 是地址的哈希，内容变了就是另一个 id，
  // 所以盒子第二次进点播一个请求都不用发。
  // 带上长度，省掉 chunked —— 二十几 KB 的图不值得分块传。
  return reply
    .type(got.mime)
    .header('Content-Length', got.bytes)
    .header('Cache-Control', 'public, max-age=31536000, immutable')
    .send(createReadStream(got.path));
});

app.get('/api/preview/:streamId', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;

  if (!settings.tvConfig(dev.property_id).channelPreview) return { url: null, off: true };

  /*
   * 受限频道一张都不生成，**而且按「没解锁」判**（第二个参数写死 false）。
   * 图片落在 /media/ 下是公开可取的：给成人分类截一张，等于在 PIN 外面开窗。
   * 解锁过的盒子也不例外 —— 文件一旦存在，谁都能取。
   */
  if (!(await adult.playAllowed(dev, false, 'live', req.params.streamId))) {
    return { url: null, restricted: true };
  }

  const shot = previews.ensure(properties.lineOf(dev), req.params.streamId);
  return { url: shot?.url ?? null, ageMs: shot?.ageMs ?? null };
});

app.get('/api/play/:streamId', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;

  // The catalogue stays visible when a section is behind the paywall; only
  // playback is refused. A guest who cannot see what they would be buying has
  // no reason to buy it.
  if (!billing.allowed(dev, 'live')) {
    return reply.code(402).send({ error: 'payment required', section: 'live' });
  }
  // Guessing a stream id must not be a way past the PIN.
  if (!(await adult.playAllowed(dev, adult.isUnlocked(req, dev), 'live', req.params.streamId))) {
    return reply.code(403).send({ error: 'restricted' });
  }

  const ext = req.query.ext === 'ts' ? 'ts' : 'm3u8';
  const direct = xui.liveUrl(properties.lineOf(dev), req.params.streamId, ext);

  /*
   * `relay=1` means "I cannot fetch this myself".
   *
   * Two clients say it. A browser says it from the start, because it cannot
   * follow the panel's redirect down to plain HTTP. A box says it only after
   * trying: it can follow the redirect, but the player that survives these
   * streams reads playlists over XHR, and a handful of the upstream CDNs send
   * no CORS header at all - three of ninety-one, at the last count. Those are
   * unreachable from a page whatever the box allows, so the fleet asks for a
   * relay for exactly those and keeps taking the direct URL for the rest.
   *
   * It stays a request from the client rather than something sniffed from a
   * user agent, because the client is the only party that knows what failed.
   */
  if (req.query.relay === '1') {
    return { url: `/hls/${mint(direct)}/index.m3u8`, relayed: true };
  }
  return { url: direct, relayed: false };
});

// -------------------------------------------------------------------- vod

/**
 * Films and series in one list.
 *
 * The panel keeps them in separate namespaces because it stores them
 * differently, but to someone holding a remote they are one shelf, so the
 * split is resolved here rather than in the TV app.
 */
app.get('/api/vod', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;

  const line = properties.lineOf(dev);
  const [movieCats, movies, seriesCats, series] = await Promise.all([
    xui.vodCategories(line),
    xui.vodStreams(line),
    xui.seriesCategories(line),
    xui.seriesList(line),
  ]);

  const unlocked = adult.isUnlocked(req, dev);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const names = new Map(
    [...arr(movieCats), ...arr(seriesCats)].map((c) => [String(c.category_id), c.category_name]),
  );

  const items = [
    ...arr(movies).map((m) => ({
      id: m.stream_id,
      kind: 'movie',
      name: m.title || m.name,
      icon: art.proxy(xui.publicAsset(m.stream_icon, line)),
      year: m.year || null,
      rating: Number(m.rating) || 0,
      categoryId: String(m.category_id ?? ''),
      container: m.container_extension || 'm3u8',
    })),
    ...arr(series).map((s) => ({
      id: s.series_id,
      kind: 'series',
      name: s.title || s.name,
      icon: art.proxy(xui.publicAsset(s.cover, line)),
      year: s.year || null,
      rating: Number(s.rating) || 0,
      categoryId: String(s.category_id ?? ''),
      container: null,
    })),
  ]
    .map((it) => {
      // Whether this is restricted is settled against the panel's own category
      // - `vod:43`, `series:30` - before the collapse below throws that id
      // away. Films and series number their categories separately, so the id
      // only means anything while the namespace it came from is still known.
      const name = names.get(it.categoryId) ?? 'Lainnya';
      const flagged =
        adult.adultEnabled(dev.property_id) &&
        adult.isAdultCategory(
          dev.property_id,
          name,
          it.kind === 'series' ? 'series' : 'vod',
          it.categoryId,
        );
      // The panel needs a movie category and a series category even when both
      // are called 动作片, so collapse them by name - a viewer should see one
      // shelf, not the same shelf twice.
      /*
       * 搜索用的首字母串，在这里算好带下去。
       *
       * 算在服务端而不是电视上：盒子那点 CPU 不该用来跑 868 次拼音归类，
       * 而且这份结果对同一家酒店的每台电视都一样。带下去之后电视端的搜索
       * 是纯内存过滤，按一个字母出一次结果，没有任何请求。
       */
      return { ...it, categoryId: name, categoryName: name, adult: flagged, py: initials(it.name) };
    })
    .filter((it) => unlocked || !it.adult);

  const counts = new Map();
  const flaggedNames = new Set();
  for (const it of items) {
    counts.set(it.categoryId, (counts.get(it.categoryId) ?? 0) + 1);
    if (it.adult) flaggedNames.add(it.categoryId);
  }

  const categories = [...counts]
    .map(([name, count]) => ({ id: name, name, count, adult: flaggedNames.has(name) }))
    // Biggest shelf first, but the restricted ones always last - 29 of them
    // arriving at once is exactly what pushed the ordinary catalogue off the
    // bottom of the screen.
    .sort((a, b) => Number(a.adult) - Number(b.adult) || b.count - a.count);

  /*
   * 趁这一次把整个片库的海报先抓下来。
   *
   * 第一个进点播的客人只会等到眼前这几张（现抓），剩下的在后台慢慢填；
   * 之后每个房间、每次开机都是本地命中。不等它 —— 列表这就得发出去。
   */
  void art.warm(
    items.map((it) => String(it.icon ?? '').split('/api/art/')[1]).filter(Boolean),
    req.log,
  );

  return { categories, items };
});

/** The panel decorates titles with "(2004)"; the UI shows the year on its own. */
const undecorate = (s) => String(s || '').replace(/\s*\((?:19|20)\d{2}\)\s*$/, '').trim();
const yearOf = (...vals) => {
  for (const v of vals) {
    const m = String(v ?? '').match(/(19|20)\d{2}/);
    if (m) return m[0];
  }
  return '';
};

app.get('/api/vod/:kind/:id', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;

  const { kind, id } = req.params;
  if (!(await adult.playAllowed(dev, adult.isUnlocked(req, dev), kind, id))) {
    return reply.code(403).send({ error: 'restricted' });
  }
  const line = properties.lineOf(dev);

  if (kind === 'movie') {
    const raw = await xui.vodInfo(line, id);
    const info = raw?.info ?? {};
    const data = raw?.movie_data ?? {};
    return {
      kind: 'movie',
      id: Number(id),
      name: undecorate(data.name || info.name),
      plot: info.plot || info.description || '',
      cast: info.cast || info.actors || '',
      director: info.director || '',
      genre: info.genre || '',
      year: yearOf(info.releasedate, info.release_date),
      released: info.releasedate || info.release_date || '',
      rating: Number(info.rating) || 0,
      cover: art.proxy(xui.publicAsset(info.movie_image || info.cover_big, line)),
      duration: info.duration || '',
      container: data.container_extension || 'm3u8',
    };
  }

  if (kind === 'series') {
    const raw = await xui.seriesInfo(line, id);
    const info = raw?.info ?? {};
    // The panel keys episodes by season number; flatten to an ordered list
    // because a remote steps through episodes, not through a nested object.
    const showName = undecorate(info.name || info.title);
    // A stream row has to carry the show's name to be identifiable in the
    // panel, but repeating it on every line of an episode list is noise.
    const trimEpisode = (t) => {
      const s = String(t || '').trim();
      const stripped = showName && s.startsWith(showName) ? s.slice(showName.length) : s;
      return stripped.replace(/^[\s\-–—·:]+/, '').trim() || s;
    };

    const episodes = Object.entries(raw?.episodes ?? {})
      .flatMap(([season, list]) =>
        (Array.isArray(list) ? list : []).map((e) => ({
          id: Number(e.id),
          season: Number(e.season ?? season) || 1,
          num: Number(e.episode_num) || 0,
          title: trimEpisode(e.title) || `第${e.episode_num}集`,
          container: e.container_extension || 'm3u8',
        })),
      )
      .sort((a, b) => a.season - b.season || a.num - b.num);

    return {
      kind: 'series',
      id: Number(id),
      name: showName,
      plot: info.plot || '',
      cast: info.cast || '',
      director: info.director || '',
      genre: info.genre || '',
      year: yearOf(info.year, info.releaseDate, info.release_date),
      released: info.releaseDate || info.release_date || '',
      rating: Number(info.rating) || 0,
      cover: art.proxy(xui.publicAsset(info.cover, line)),
      episodes,
    };
  }

  return reply.code(400).send({ error: 'kind must be movie or series' });
});

app.get('/api/vod/play/:kind/:id', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;

  const { kind, id } = req.params;
  if (!(await adult.playAllowed(dev, adult.isUnlocked(req, dev), kind, id))) {
    return reply.code(403).send({ error: 'restricted' });
  }
  if (!billing.allowed(dev, 'vod')) {
    return reply.code(402).send({ error: 'payment required', section: 'vod' });
  }
  // Whitelisted so a crafted extension cannot be pushed into the panel URL.
  const ext = /^[a-z0-9]{2,5}$/i.test(String(req.query.ext || '')) ? String(req.query.ext) : 'm3u8';

  let direct;
  const line = properties.lineOf(dev);
  if (kind === 'movie') direct = xui.movieUrl(line, id, ext);
  else if (kind === 'episode') direct = xui.episodeUrl(line, id, ext);
  else return reply.code(400).send({ error: 'kind must be movie or episode' });

  // Same bargain as live: the client asks, having found out the hard way.
  if (req.query.relay === '1') {
    return { url: `/hls/${mint(direct)}/index.m3u8`, relayed: true };
  }
  return { url: direct, relayed: false };
});

// ---------------------------------------------------------------- hospitality

app.get('/api/service/menu', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;

  const items = db
    .prepare(
      'SELECT * FROM service_items WHERE available = 1 AND property_id = ? ORDER BY category, sort_order, id',
    )
    .all(dev.property_id);

  const grouped = {};
  for (const it of items) {
    (grouped[it.category] ??= []).push({
      id: it.id,
      name: { en: it.name_en, zh: it.name_zh, id: it.name_id, km: it.name_km },
      price: it.price,
      currency: it.currency,
      image: it.image,
    });
  }
  return { categories: Object.entries(grouped).map(([name, items]) => ({ name, items })) };
});

app.post('/api/service/order', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;

  const { items, note } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) {
    return reply.code(400).send({ error: 'items required' });
  }

  let total = 0;
  const resolved = [];
  for (const line of items) {
    // 带上酒店：客人只能点自己这家菜单上的东西，猜到别家的菜品 id 也没用。
    const row = db
      .prepare('SELECT * FROM service_items WHERE id = ? AND available = 1 AND property_id = ?')
      .get(line.id, dev.property_id);
    if (!row) return reply.code(400).send({ error: 'unknown item ' + line.id });
    const qty = Math.max(1, Math.min(20, Number(line.qty) || 1));
    total += row.price * qty;
    resolved.push({ id: row.id, name: row.name_en, qty, price: row.price });
  }

  const info = db
    .prepare(
      'INSERT INTO orders (property_id, room_id, device_id, items_json, total, note, status, created_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      dev.property_id,
      dev.room_id,
      dev.device_id,
      JSON.stringify(resolved),
      total,
      note ?? null,
      'new',
      now(),
    );

  const orderId = Number(info.lastInsertRowid);

  /*
   * Payment is attached to the order, not required before it.
   *
   * If the gateway is off, or refuses, the order still stands - it just goes to
   * the front desk unpaid, the way it did before there was a gateway. A
   * room-service order that vanishes because a payment gateway hiccuped is a
   * guest who thinks nobody is coming.
   */
  let payment = null;
  const scope = pay.scopeOf('service', dev.property_id);
  const money = svc.currencyCheck(dev.property_id);
  if (pay.payEnabled(scope) && !money.ok) {
    // 见 service.js currencyCheck：宁可让这一单走前台，也不能按错误的币种收款。
    req.log.error({ orderId, reason: money.reason }, '菜单币种和收款币种对不上，这一单不走线上收款');
  } else if (pay.payEnabled(scope)) {
    try {
      payment = await pay.createOrder({
        kind: 'service',
        refId: orderId,
        propertyId: dev.property_id,
        deviceId: dev.device_id,
        roomId: dev.room_id,
        amountCents: pay.toMinor(total, pay.currency(scope)),
        subject: `${dev.room_id ? '房间 ' + dev.room_id + ' · ' : ''}客房服务 #${orderId}`,
        clientIp: req.ip,
      });
    } catch (err) {
      req.log.error({ err: err.message, orderId }, '客房服务订单建收款失败，订单按未付款留给前台');
    }
  }

  return { ok: true, orderId, total, items: resolved, payment };
});

app.get('/api/service/orders', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;
  const rows = db
    .prepare('SELECT * FROM orders WHERE device_id = ? AND property_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(dev.device_id, dev.property_id);
  return { orders: rows.map((r) => ({ ...r, items: JSON.parse(r.items_json) })) };
});

app.get('/api/notices', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;
  const rows = db
    .prepare(
      'SELECT * FROM notices WHERE property_id = ? AND (room_id IS NULL OR room_id = ?)' +
        ' AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 20',
    )
    .all(dev.property_id, dev.room_id, now());
  return { notices: rows };
});

// ---------------------------------------------------------------- OTA

// The shell APK polls this. Because the UI is a web bundle served from here,
// shipping a new UI to every box is a redeploy of this service - no APK
// rollout, no visiting hotels.
/**
 * 这一版网页的指纹。
 *
 * **不能用 APP_VERSION** —— 那是环境变量里写死的，部署一百次也不会变，
 * 拿它判断「网页换了没」永远是「没换」。
 *
 * 用构建产物本身：vite 打出来的 index.html 里引的是 `assets/index-<hash>.js`，
 * 内容一变文件名就变。算一次，进程活着期间不会再变 —— 换了页面也就换了进程。
 */
const bundleId = (() => {
  try {
    // 和下面 fastify-static 用的是同一个路径，否则算的是另一份文件的指纹。
    const dist = config.webDist || join(here, '..', '..', 'web', 'dist');
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    return createHash('sha1').update(html).digest('hex').slice(0, 12);
  } catch {
    return null; // 没有构建产物（开发时用 vite dev），那就没这个功能
  }
})();

app.get('/api/app/version', async () => ({
  version: config.appVersion,
  // 网页换了没，看这个。见 web/src/updater.ts。
  bundle: bundleId,
  bundleUrl: '/',
  // Bump this only when the native shell itself must change.
  minShellVersion: 1,
}));

app.get('/api/weather', async () => (await weather.current()) ?? { unavailable: true });

/**
 * Everything the launcher needs to dress itself, in one call.
 *
 * `backgroundUrl` is still here for older bundles already installed on boxes;
 * new ones read `background`, which is the only field that can describe a
 * video. Dropping the old field would blank the background on any television
 * that has not fetched the new bundle yet.
 */
/**
 * 电视要的门面配置。
 *
 * 这条路**不要求盒子已激活** —— 还没配对的盒子也得知道该显示谁的名字和
 * 背景，否则配对码那一页会是一片黑。但它确实要求认得出这台盒子属于哪一家：
 * 认不出来就给一份中性的默认，而不是随便挑一家的品牌。
 */
app.get('/api/app/home', async (req) => {
  const dev = req.headers['x-device-id'] ? getDevice(String(req.headers['x-device-id'])) : null;
  const pid = dev?.property_id ?? null;

  // 认不出这台盒子属于谁，就给一份中性的默认 —— 不是随手挑一家的品牌。
  if (pid == null) {
    return {
      propertyName: config.home.propertyName,
      supportContact: config.home.supportContact || null,
      welcomeText: null,
      background: { type: 'none', url: null, poster: null },
      scenes: { live: null, vod: null, service: null },
      branding: { splashUrl: null, loadingUrl: null, logoUrl: null, accent: null, customCss: '' },
      version: config.appVersion,
      backgroundUrl: null,
    };
  }

  const home = settings.homeConfig(pid);
  return {
    ...home,
    backgroundUrl: home.background.type === 'image' ? home.background.url : null,
  };
});

/**
 * The operator's theme, as a real stylesheet.
 *
 * Linked from the app's <head> so it applies with the rest of the CSS rather
 * than after first paint - a theme injected by script is a visible flash of
 * the wrong colours on every boot. `nosniff` matters here: the body contains
 * operator-authored text, and this guarantees no browser ever reconsiders it
 * as anything but CSS.
 */
app.get('/theme.css', async (req, reply) => {
  /*
   * 这是唯一一条靠查询串认盒子的路 —— <link> 带不了自定义请求头。
   * 认不出来就回一份空的（也就是默认主题），不能猜一家。
   */
  const dev = req.query?.d ? getDevice(String(req.query.d)) : null;
  const pid = dev?.property_id ?? null;

  reply
    .header('Content-Type', 'text/css; charset=utf-8')
    .header('X-Content-Type-Options', 'nosniff')
    // 每家一份，所以不能被中间层当成同一个资源缓存给别家。
    .header('Vary', 'Accept-Encoding')
    // Short rather than none: a themed change should reach the boxes within a
    // minute, but a fleet rebooting at 7am should not each miss the cache.
    .header('Cache-Control', 'public, max-age=60');
  return pid == null ? '' : settings.themeCss(pid);
});

// ------------------------------------------------------------------- 收款

/*
 * Jeepay 可能发 JSON，也可能发表单。fastify 只认前者，碰到后者会直接
 * 415，而网关看到非 2xx 就会一直重发 —— 一笔已经付掉的钱在日志里刷屏，
 * 订单却永远是待付款。所以这里把表单也解出来。
 */
app.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body)));
    } catch (err) {
      done(err);
    }
  },
);

/**
 * 支付网关的异步通知。
 *
 * 这条路**没有登录**，也不可能有 —— 支付平台带不了我们的令牌。
 * 它的安全性完全来自签名校验，所以那一步绝不能跳过、绝不能「先记下来再说」。
 *
 * 返回体必须是纯文本 success。回别的东西 Jeepay 会认为失败并反复重发。
 */
app.post('/api/pay/notify/jeepay', async (req, reply) => {
  const params = { ...(req.body ?? {}), ...(req.query ?? {}) };
  reply.header('Content-Type', 'text/plain; charset=utf-8');

  const parsed = pay.parseNotifyParams(params);
  if (!parsed.valid) {
    req.log.error({ orderNo: params.mchOrderNo }, '支付回调签名不通过，已丢弃');
    // 故意也回 success：签名不过说明这根本不是我们的网关发的，
    // 让它重发没有意义，而一个会重试的 400 只会变成放大器。
    return 'success';
  }

  if (!parsed.success) {
    req.log.info({ orderNo: parsed.orderNo, reason: parsed.reason }, '支付回调：未成功');
    return 'success';
  }

  try {
    const r = pay.markPaid(parsed.orderNo, {
      upstreamNo: parsed.upstreamNo,
      amountCents: parsed.amountCents,
    });
    if (!r.ok) req.log.error({ orderNo: parsed.orderNo, reason: r.reason }, '支付回调无法入账');
    else if (!r.already) req.log.info({ orderNo: parsed.orderNo }, '支付到账');
  } catch (err) {
    req.log.error({ orderNo: parsed.orderNo, err: err.message }, '支付回调处理异常');
  }
  return 'success';
});

/**
 * 电视端轮询一笔收款。
 *
 * 只能查自己这台盒子的单。别的房间付没付钱，不是这台电视该知道的事。
 */
app.get('/api/pay/status/:orderNo', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;

  const row = pay.findOrder(req.params.orderNo);
  if (!row || row.device_id !== dev.device_id) {
    return reply.code(404).send({ error: 'no such order' });
  }
  return { order: await pay.withQr(row), billing: billing.statusFor(getDevice(dev.device_id)) };
});

/** 这台盒子现在有哪些区域要付费，以及多少钱。 */
app.get('/api/billing/status', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;
  return billing.statusFor(dev);
});

/** 客人买观看权。 */
app.post('/api/billing/buy', async (req, reply) => {
  const dev = requireLine(req, reply);
  if (!dev) return;

  const days = Math.trunc(Number(req.body?.days));
  const plan = billing.guestPlans(dev.property_id).find((p) => p.days === days);
  if (!plan) return reply.code(400).send({ error: 'no such plan' });

  // 已经能看的时候不卖。酒店付着费、或者这台盒子的 pass 还没到期，
  // 这时候收钱就是卖一份他已经有的东西。
  if (!billing.statusFor(dev).locked.length) {
    return reply.code(409).send({ error: 'nothing to buy' });
  }

  try {
    const order = await pay.createOrder({
      kind: 'unlock',
      refId: plan.days,
      // 观看权的钱进平台商户，但记清楚是哪家的哪台盒子买的。
      propertyId: dev.property_id,
      deviceId: dev.device_id,
      roomId: dev.room_id,
      amountCents: pay.toMinor(plan.price, pay.currency(PLATFORM)),
      subject: `观看权 ${plan.days} 天`,
      clientIp: req.ip,
    });
    return { ok: true, payment: order };
  } catch (err) {
    return reply.code(err.statusCode ?? 500).send({ error: err.message });
  }
});

/*
 * 对账。回调之外的第二条路 —— 回调丢了的时候它是唯一一条。
 *
 * 一分钟一轮，只在配了收款通道时才真的去问网关。unref 掉，免得它拖住
 * 一次正常的退出。
 */
const reconcileTimer = setInterval(() => {
  pay.reconcile(app.log).catch((err) => app.log.error({ err: err.message }, '对账轮次失败'));
}, 60_000);
reconcileTimer.unref();

app.get('/api/health', async () => ({ ok: true, version: config.appVersion }));

// ---------------------------------------------------------------- web UI

// Uploaded backgrounds. Long-lived cache: filenames are random per upload, so
// a changed background is a different URL and never a stale one.
// fastify-static insists on an absolute root, and MEDIA_DIR is allowed to be
// relative so a source checkout works with no environment at all.
const mediaRoot = resolve(config.mediaDir);
mkdirSync(mediaRoot, { recursive: true });
await app.register(fastifyStatic, {
  root: mediaRoot,
  prefix: '/media/',
  decorateReply: false,
  cacheControl: true,
  // A stored file is never rewritten - changing the background writes a new
  // UUID, it does not edit the old one - so these can be cached hard and
  // marked immutable. That matters most for video: a 10MB loop the box would
  // otherwise re-validate is fetched once and then never again, which is the
  // difference between a background that costs the property bandwidth every
  // boot and one that costs it once per box.
  maxAge: '365d',
  immutable: true,
});

// The console itself. Plain files - it is an operator tool, not a product.
await app.register(fastifyStatic, {
  root: join(here, 'admin-ui'),
  prefix: '/admin/',
  decorateReply: false,
  index: ['index.html'],
});
app.get('/admin', async (req, reply) => reply.redirect('/admin/'));

/*
 * 前台手机页。
 *
 * 和后台**同一套接口、同一套登录**，只是身体不同：后台是坐着用的宽表格，
 * 这个是站在柜台前单手用的。分成两个地址而不是在后台里做响应式，
 * 是因为前台要的不是"把十几列缩进手机屏"，而是只剩两件事：房间、订单。
 */
await app.register(fastifyStatic, {
  root: join(here, 'desk-ui'),
  prefix: '/desk/',
  decorateReply: false,
  index: ['index.html'],
});
app.get('/desk', async (req, reply) => reply.redirect('/desk/'));

const webDist = config.webDist || join(here, '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  // The TV app is a single page, so an unknown path is a route inside it -
  // except under these prefixes, which are real files. Serving index.html for
  // a deleted background would answer 200 with HTML, and the television would
  // sit there trying to decode a web page as a photo.
  const FILES = ['/api/', '/media/', '/admin/', '/desk/', '/assets/', '/hls/'];
  app.setNotFoundHandler((req, reply) => {
    if (FILES.some((p) => req.url.startsWith(p))) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
}

await app.listen({ port: config.port, host: config.host });

// 把每个频道的预览图轮着补上 —— 客人要的是整屏扫过去每个台都有画面，
// 不是「光标移到哪张才有哪张」。放在 listen 之后：它不应该拖着服务不起来。
startPreviewSweeper(app.log);

/*
 * 没人再看的海报清掉。
 *
 * 一天一次就够 —— 它清的是「片库换过之后再也不会被请求的旧图」，
 * 不是什么随时会涨起来的东西。放在 listen 之后，理由同上。
 */
const artSweep = setInterval(() => art.sweep(app.log), 24 * 3600_000);
artSweep.unref();

/*
 * 过期的登录票和半年前的操作记录。
 *
 * 票过期在验票时就会当场删掉，这一轮扫的是**再也没人来验的那些** ——
 * 换了电脑、卸了浏览器的那一张，不扫就永远留在表里。
 */
const authSweep = setInterval(() => {
  try {
    const sessions = adminAuth.sweepSessions();
    const audit = adminAuth.sweepAudit();
    if (sessions || audit) app.log.info({ sessions, audit }, '清掉了过期的票和旧记录');
  } catch (err) {
    app.log.warn({ err: err.message }, '清理登录票失败');
  }
}, 6 * 3600_000);
authSweep.unref();
