// Thin client for the XUI.one / Xtream-codes player API, with a small
// in-process cache. Every box talks to this service instead of to XUI, so
// XUI sees one caller rather than several hundred.
//
// 每个函数的第一个参数都是一个 **line 对象**，不是两个字符串：
//
//     { username, password, api, pub, panelId }
//
// 因为一条线路离了它那台面板就没意义 —— 同一对账号密码在另一台面板上
// 要么认不过、要么是另一批内容。以前面板地址是全局配置，一台服务器只能接
// 一台面板；现在面板跟着线路走，每家酒店可以各接各的（见 panels.js）。
import { config } from './config.js';

const cache = new Map(); // key -> { at, ttl, value }

function cached(key, ttl, produce) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const value = produce();           // a promise
  cache.set(key, { at: Date.now(), ttl, value });
  // Do not cache rejections - let the next caller retry.
  value.catch(() => cache.delete(key));
  return value;
}

async function call(line, params = {}) {
  const url = new URL('/player_api.php', line.api);
  url.searchParams.set('username', line.username);
  url.searchParams.set('password', line.password);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`XUI ${res.status} on ${params.action ?? 'auth'}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`XUI returned non-JSON for ${params.action ?? 'auth'}`);
  }
}

/** Validate a line and return its user_info/server_info. */
export function authenticate(line) {
  return call(line);
}

export function liveCategories(line) {
  return cached(`cats:${line.panelId}:${line.username}`, config.xui.listTtlMs,
    () => call(line, { action: 'get_live_categories' }));
}

export function liveStreams(line) {
  return cached(`live:${line.panelId}:${line.username}`, config.xui.listTtlMs,
    () => call(line, { action: 'get_live_streams' }));
}

export function vodCategories(line) {
  return cached(`vodcats:${line.panelId}:${line.username}`, config.xui.listTtlMs,
    () => call(line, { action: 'get_vod_categories' }));
}

export function vodStreams(line) {
  return cached(`vod:${line.panelId}:${line.username}`, config.xui.listTtlMs,
    () => call(line, { action: 'get_vod_streams' }));
}

export function seriesCategories(line) {
  return cached(`sercats:${line.panelId}:${line.username}`, config.xui.listTtlMs,
    () => call(line, { action: 'get_series_categories' }));
}

export function seriesList(line) {
  return cached(`series:${line.panelId}:${line.username}`, config.xui.listTtlMs,
    () => call(line, { action: 'get_series' }));
}

export function seriesInfo(line, seriesId) {
  return cached(`serinfo:${line.panelId}:${line.username}:${seriesId}`, config.xui.listTtlMs,
    () => call(line, { action: 'get_series_info', series_id: seriesId }));
}

export function vodInfo(line, vodId) {
  return cached(`vodinfo:${line.panelId}:${line.username}:${vodId}`, config.xui.listTtlMs,
    () => call(line, { action: 'get_vod_info', vod_id: vodId }));
}

export function shortEpg(line, streamId, limit = 8) {
  return cached(`epg:${line.panelId}:${line.username}:${streamId}:${limit}`, config.xui.epgTtlMs,
    () => call(line, { action: 'get_short_epg', stream_id: streamId, limit }));
}

/**
 * Playback URL for a live channel. Built against the PUBLIC address because
 * the box fetches video directly - proxying video through this service would
 * make it the bandwidth bottleneck.
 */
export function liveUrl(line, streamId, ext = 'm3u8') {
  return `${line.pub}/live/${encodeURIComponent(line.username)}/${encodeURIComponent(line.password)}/${streamId}.${ext}`;
}

/**
 * On-demand playback URLs. Same reasoning as live: the box fetches the video
 * itself. The extension is not cosmetic - it is how the panel decides what to
 * hand back, and how the player knows whether it is opening an HLS manifest.
 */
export function movieUrl(line, streamId, ext = 'm3u8') {
  return `${line.pub}/movie/${encodeURIComponent(line.username)}/${encodeURIComponent(line.password)}/${streamId}.${ext}`;
}

export function episodeUrl(line, streamId, ext = 'm3u8') {
  return `${line.pub}/series/${encodeURIComponent(line.username)}/${encodeURIComponent(line.password)}/${streamId}.${ext}`;
}

/**
 * Rewrite a panel-hosted asset onto the public base.
 *
 * The panel hands back logo URLs on its own plain-HTTP origin. Served inside
 * an HTTPS page those are blocked as mixed content, and on a box they would be
 * one more cleartext request; the public base is reachable over TLS and
 * proxies to the same files.
 */
export function publicAsset(url, line) {
  const raw = String(url || '').trim();
  if (!raw) return null;

  const publicBase = String(line?.pub ?? '').replace(/\/+$/, '');
  if (!publicBase) return raw;

  // The panel also emits bare paths for its own files.
  if (raw.startsWith('/')) return publicBase + raw;

  let asset;
  let panel;
  try {
    asset = new URL(raw);
    panel = new URL(line.api);
  } catch {
    return raw;
  }

  // Compare hostnames, not string prefixes: the panel writes its own URLs with
  // an explicit ":80" that the configured base does not carry, and a prefix
  // match leaves that port stranded in the middle of the rewritten URL.
  if (asset.hostname !== panel.hostname) return raw;

  return publicBase + asset.pathname + asset.search;
}

/** XUI base64-encodes EPG titles and descriptions. */
export function decodeEpgText(s) {
  if (!s) return '';
  try {
    return Buffer.from(s, 'base64').toString('utf8');
  } catch {
    return s;
  }
}
