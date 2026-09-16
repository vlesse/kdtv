/**
 * The restricted section.
 *
 * A hotel that carries adult channels has to be able to answer three
 * questions, and this module is where each is answered:
 *
 *   1. Is this room allowed it at all? Per device, off by default. A family
 *      floor, a dormitory or a room with a child in it simply never has the
 *      section, and no PIN can conjure it up.
 *   2. Did whoever is holding the remote prove they may see it? A PIN, checked
 *      here rather than in the television app.
 *   3. Can it be reached any other way? No - and that is the part that makes
 *      this real. Hiding a category in the interface stops nobody: the stream
 *      ids are sequential and the API is a public domain away. So a locked
 *      device is not merely shown less, it is *told* less, and a play request
 *      for a restricted stream is refused outright even if the id was guessed.
 *
 * The PIN is stored as a scrypt hash. It guards content rather than money, but
 * an operator who reuses their door code deserves better than a plaintext row.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { getSetting, setSetting } from './settings.js';
import * as xui from './xui.js';

/** An unlock lasts a viewing, not a stay. */
const UNLOCK_TTL_MS = 30 * 60 * 1000;

/** Wrong PINs before a device has to wait. Five is generous for four digits. */
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 10 * 60 * 1000;

/** How long the set of restricted stream ids is trusted before re-fetching. */
const ID_CACHE_MS = 5 * 60 * 1000;

/**
 * Category names that are restricted whether or not anyone configured them.
 *
 * This is the safety net, not the mechanism. Matching names was the original
 * design and it failed the first time real stock arrived: a panel gained 29
 * adult categories at once - 伦理影片, 日韩无码, 黑料网曝, 动漫精品 - and not
 * one of them contains any of these words. Chinese resource sites simply do
 * not name things "adult". So what is restricted is now *chosen*, category by
 * category, in the console, and these keywords only catch a bouquet that
 * appeared since someone last looked.
 *
 * Matching is on substrings, case-insensitively, across the languages these
 * lists actually arrive in. An operator's own list extends this one; it can
 * never shrink it.
 */
const BUILT_IN = [
  'adult',
  'xxx',
  '18+',
  '+18',
  'porn',
  'erotic',
  'sex',
  'for men',
  '成人',
  '情色',
  '色情',
  '18禁',
  'dewasa',
];

// ------------------------------------------------------------------ config

/*
 * Both halves of the rule are read for every channel in a listing - ninety-one
 * of them, three times over - so they are parsed once and kept. The cache is
 * dropped by `invalidateRestricted()`, which every write to these settings
 * already calls.
 */
/*
 * 每家酒店一份。以前是一个全局变量 —— 十家酒店共用的话，A 店勾的受限分类会
 * 直接决定 B 店哪些频道被藏起来。
 */
const rules = new Map();

function currentRules(pid) {
  const cached = rules.get(pid);
  if (cached) return cached;

  let patterns = [];
  try {
    const raw = JSON.parse(getSetting(pid, 'adult.categories') || '[]');
    if (Array.isArray(raw)) {
      patterns = raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    }
  } catch {
    /* a malformed row simply means no extra keywords */
  }

  let picked = new Set();
  try {
    const raw = JSON.parse(getSetting(pid, 'adult.categoryIds') || '[]');
    if (Array.isArray(raw)) picked = new Set(raw.map(String));
  } catch {
    /* likewise: nothing ticked */
  }

  const built = { patterns: [...BUILT_IN, ...patterns], picked };
  rules.set(pid, built);
  return built;
}

/** The ticked categories, as `kind:id` keys. */
export function pickedCategories(pid) {
  return [...currentRules(pid).picked];
}

export function setPickedCategories(pid, keys) {
  const clean = [...new Set((Array.isArray(keys) ? keys : []).map(String))]
    .filter((k) => /^(live|vod|series):[A-Za-z0-9_-]{1,32}$/.test(k))
    .slice(0, 500);
  setSetting(pid, 'adult.categoryIds', JSON.stringify(clean));
}

/**
 * Does this category belong to the restricted section?
 *
 * Identity first, name second. A category that was ticked in the console is
 * restricted whatever it is called - which is the entire point, because what
 * these are called cannot be relied on.
 */
export function isAdultCategory(pid, name, kind, id) {
  const { patterns, picked } = currentRules(pid);
  if (kind && id !== undefined && id !== null && picked.has(`${kind}:${id}`)) return true;
  const s = String(name ?? '').toLowerCase();
  if (!s) return false;
  return patterns.some((p) => s.includes(p));
}

export function adultEnabled(pid) {
  return getSetting(pid, 'adult.enabled') === '1';
}

export function pinIsSet(pid) {
  return Boolean(getSetting(pid, 'adult.pin.hash') && getSetting(pid, 'adult.pin.salt'));
}

export function setPin(pid, pin) {
  const salt = randomBytes(16).toString('hex');
  setSetting(pid, 'adult.pin.salt', salt);
  setSetting(pid, 'adult.pin.hash', scryptSync(String(pin), salt, 32).toString('hex'));
}

export function clearPin(pid) {
  setSetting(pid, 'adult.pin.salt', null);
  setSetting(pid, 'adult.pin.hash', null);
}

function pinMatches(pid, given) {
  const salt = getSetting(pid, 'adult.pin.salt');
  const hash = getSetting(pid, 'adult.pin.hash');
  if (!salt || !hash) return false;
  const a = scryptSync(String(given ?? ''), salt, 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether this particular box may ever show the section. */
export function deviceAllowed(dev) {
  return Boolean(dev?.adult_allowed);
}

export function setDeviceAllowed(deviceId, allowed) {
  db.prepare('UPDATE devices SET adult_allowed = ? WHERE device_id = ?')
    .run(allowed ? 1 : 0, String(deviceId));
}

/**
 * What the television is told before any PIN is entered.
 *
 * `available` false means the tile is not drawn at all - which is the honest
 * answer, because on this box there is nothing behind it.
 */
export function status(dev) {
  // 酒店 id 从盒子本身读，不从调用方拿：这两个值一旦对不上就是串台。
  const pid = dev?.property_id;
  return {
    available: adultEnabled(pid) && pinIsSet(pid) && deviceAllowed(dev),
    unlocked: false,
  };
}

// ------------------------------------------------------------------ unlock

/** token -> { deviceId, at } */
const unlocks = new Map();
/** deviceId -> { fails, until } */
const attempts = new Map();

function sweep() {
  const cutoff = Date.now() - UNLOCK_TTL_MS;
  for (const [k, v] of unlocks) if (v.at < cutoff) unlocks.delete(k);
  for (const [k, v] of attempts) if (v.until && v.until < Date.now() && v.fails === 0) attempts.delete(k);
}

/**
 * Try a PIN.
 *
 * Returns a token, or how long the device has to wait. The counter is per
 * device rather than global so one room fumbling its PIN cannot lock the
 * section for the whole building.
 */
export function unlock(dev, pin) {
  sweep();
  const id = dev.device_id;
  const state = attempts.get(id) ?? { fails: 0, until: 0 };

  if (state.until > Date.now()) {
    return { ok: false, retryAfterMs: state.until - Date.now() };
  }
  const pid = dev?.property_id;
  if (!adultEnabled(pid) || !pinIsSet(pid) || !deviceAllowed(dev)) {
    return { ok: false, unavailable: true };
  }
  if (!pinMatches(pid, pin)) {
    state.fails += 1;
    if (state.fails >= MAX_ATTEMPTS) {
      state.fails = 0;
      state.until = Date.now() + LOCKOUT_MS;
      attempts.set(id, state);
      return { ok: false, retryAfterMs: LOCKOUT_MS };
    }
    attempts.set(id, state);
    return { ok: false, remaining: MAX_ATTEMPTS - state.fails };
  }

  attempts.delete(id);
  const token = randomBytes(16).toString('hex');
  unlocks.set(token, { deviceId: id, at: Date.now() });
  return { ok: true, token, expiresInMs: UNLOCK_TTL_MS };
}

export function lock(token) {
  if (token) unlocks.delete(String(token));
}

/**
 * Is this request allowed to see restricted content?
 *
 * The token is bound to the device that earned it, so it cannot be lifted off
 * one box and replayed from another. Its clock is not refreshed on use: an
 * unlock is a window, not a rolling session, and it should close on its own
 * after the guest has moved on.
 */
export function isUnlocked(req, dev) {
  if (!adultEnabled(dev?.property_id) || !deviceAllowed(dev)) return false;
  const token = req.headers['x-adult-token'];
  if (!token) return false;
  const entry = unlocks.get(String(token));
  if (!entry) return false;
  if (Date.now() - entry.at > UNLOCK_TTL_MS) {
    unlocks.delete(String(token));
    return false;
  }
  return entry.deviceId === dev.device_id;
}

// ------------------------------------------------- restricted stream ids

/** line_user -> { at, live:Set, movie:Set, series:Set, episode:Set } */
const idCache = new Map();

/**
 * Throw the cache away.
 *
 * Called whenever an operator changes what counts as restricted. Without this
 * the guard runs on a five-minute-old idea of which categories are which, so
 * adding a keyword filters the *listing* immediately while leaving playback
 * open for the next five minutes - a gap that is invisible from the console
 * and exactly the wrong way round.
 */
export function invalidateRestricted(pid) {
  idCache.clear();
  if (pid === undefined) rules.clear();
  else rules.delete(pid);
}

/**
 * The stream ids behind the section, for the guard on playback.
 *
 * Built from the panel's own category lists, cached briefly because it costs
 * four upstream calls and the answer changes about as often as the operator
 * edits their bouquets.
 */
export async function restrictedIds(dev) {
  const pid = dev?.property_id;

  /*
   * 缓存键必须把酒店也带上。
   *
   * 这份名单是「这条线路有哪些分类」和「这家酒店勾了哪些」算出来的乘积。
   * 十家酒店默认共用同一条线路，只按 line_user 做键的话，A 店勾的受限分类
   * 会被 B 店直接拿去用 —— B 店的客人会发现一批频道莫名其妙消失了，
   * 而 A 店可能反过来漏出不该露的。
   */
  const key = `${pid}:${dev.line_user}`;
  const hit = idCache.get(key);
  if (hit && Date.now() - hit.at < ID_CACHE_MS) return hit;

  const u = dev.line_user;
  const p = dev.line_pass;
  const arr = (v) => (Array.isArray(v) ? v : []);

  const [liveCats, live, movieCats, movies, seriesCats, series] = await Promise.all([
    xui.liveCategories(u, p),
    xui.liveStreams(u, p),
    xui.vodCategories(u, p),
    xui.vodStreams(u, p),
    xui.seriesCategories(u, p),
    xui.seriesList(u, p),
  ]);

  const flagged = (cats, kind) =>
    new Set(
      arr(cats)
        .filter((c) => isAdultCategory(pid, c.category_name, kind, c.category_id))
        .map((c) => String(c.category_id)),
    );

  const liveBad = flagged(liveCats, 'live');
  const movieBad = flagged(movieCats, 'vod');
  const seriesBad = flagged(seriesCats, 'series');

  const pickIds = (items, bad, idField) =>
    new Set(
      arr(items)
        .filter((s) => bad.has(String(s.category_id ?? '')))
        .map((s) => Number(s[idField])),
    );

  const entry = {
    at: Date.now(),
    live: pickIds(live, liveBad, 'stream_id'),
    movie: pickIds(movies, movieBad, 'stream_id'),
    series: pickIds(series, seriesBad, 'series_id'),
    episode: new Set(),
  };

  /*
   * Episodes need collecting separately, and this is the hole that would
   * otherwise be left wide open: an episode id belongs to no category at all,
   * so a restricted series whose listing is hidden would still hand over every
   * episode to anyone who asked for one by number. The only place the mapping
   * exists is the panel's per-series detail, so it is walked once - for the
   * restricted series only, which is a handful - and cached with the rest.
   */
  await Promise.all(
    [...entry.series].map(async (seriesId) => {
      try {
        const raw = await xui.seriesInfo(u, p, seriesId);
        for (const list of Object.values(raw?.episodes ?? {})) {
          for (const e of arr(list)) entry.episode.add(Number(e.id));
        }
      } catch {
        /* a series that will not describe itself simply guards nothing extra */
      }
    }),
  );

  idCache.set(key, entry);
  return entry;
}

/**
 * The gate every content route funnels through.
 *
 * Deliberately fails closed: if the panel cannot be reached to work out what
 * is restricted, a locked device is refused rather than served. A guest seeing
 * "unavailable" for a minute is a much smaller problem than the alternative.
 */
export async function playAllowed(dev, unlocked, kind, id) {
  if (unlocked) return true;
  if (!adultEnabled(dev?.property_id)) return true;
  let ids;
  try {
    ids = await restrictedIds(dev);
  } catch {
    return false;
  }
  const n = Number(id);
  if (kind === 'live') return !ids.live.has(n);
  if (kind === 'movie') return !ids.movie.has(n);
  if (kind === 'series') return !ids.series.has(n);
  if (kind === 'episode') return !ids.episode.has(n);
  return true;
}

export const constants = { UNLOCK_TTL_MS, MAX_ATTEMPTS, LOCKOUT_MS };
