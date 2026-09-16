// Thin client for the XUI.one / Xtream-codes player API, with a small
// in-process cache. Every box talks to this service instead of to XUI, so
// XUI sees one caller rather than several hundred.
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

async function call(user, pass, params = {}) {
  const url = new URL('/player_api.php', config.xui.base);
  url.searchParams.set('username', user);
  url.searchParams.set('password', pass);
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
export function authenticate(user, pass) {
  return call(user, pass);
}

export function liveCategories(user, pass) {
  return cached(`cats:${user}`, config.xui.listTtlMs,
    () => call(user, pass, { action: 'get_live_categories' }));
}

export function liveStreams(user, pass) {
  return cached(`live:${user}`, config.xui.listTtlMs,
    () => call(user, pass, { action: 'get_live_streams' }));
}

export function vodCategories(user, pass) {
  return cached(`vodcats:${user}`, config.xui.listTtlMs,
    () => call(user, pass, { action: 'get_vod_categories' }));
}

export function vodStreams(user, pass) {
  return cached(`vod:${user}`, config.xui.listTtlMs,
    () => call(user, pass, { action: 'get_vod_streams' }));
}

export function seriesCategories(user, pass) {
  return cached(`sercats:${user}`, config.xui.listTtlMs,
    () => call(user, pass, { action: 'get_series_categories' }));
}

export function seriesList(user, pass) {
  return cached(`series:${user}`, config.xui.listTtlMs,
    () => call(user, pass, { action: 'get_series' }));
}

export function seriesInfo(user, pass, seriesId) {
  return cached(`serinfo:${user}:${seriesId}`, config.xui.listTtlMs,
    () => call(user, pass, { action: 'get_series_info', series_id: seriesId }));
}

export function vodInfo(user, pass, vodId) {
  return cached(`vodinfo:${user}:${vodId}`, config.xui.listTtlMs,
    () => call(user, pass, { action: 'get_vod_info', vod_id: vodId }));
}

export function shortEpg(user, pass, streamId, limit = 8) {
  return cached(`epg:${user}:${streamId}:${limit}`, config.xui.epgTtlMs,
    () => call(user, pass, { action: 'get_short_epg', stream_id: streamId, limit }));
}

/**
 * Playback URL for a live channel. Built against the PUBLIC address because
 * the box fetches video directly - proxying video through this service would
 * make it the bandwidth bottleneck.
 */
export function liveUrl(user, pass, streamId, ext = 'm3u8') {
  return `${config.xui.publicBase}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${streamId}.${ext}`;
}

/**
 * On-demand playback URLs. Same reasoning as live: the box fetches the video
 * itself. The extension is not cosmetic - it is how the panel decides what to
 * hand back, and how the player knows whether it is opening an HLS manifest.
 */
export function movieUrl(user, pass, streamId, ext = 'm3u8') {
  return `${config.xui.publicBase}/movie/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${streamId}.${ext}`;
}

export function episodeUrl(user, pass, streamId, ext = 'm3u8') {
  return `${config.xui.publicBase}/series/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${streamId}.${ext}`;
}

/**
 * Rewrite a panel-hosted asset onto the public base.
 *
 * The panel hands back logo URLs on its own plain-HTTP origin. Served inside
 * an HTTPS page those are blocked as mixed content, and on a box they would be
 * one more cleartext request; the public base is reachable over TLS and
 * proxies to the same files.
 */
export function publicAsset(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;

  const publicBase = config.xui.publicBase.replace(/\/+$/, '');

  // The panel also emits bare paths for its own files.
  if (raw.startsWith('/')) return publicBase + raw;

  let asset;
  let panel;
  try {
    asset = new URL(raw);
    panel = new URL(config.xui.base);
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
