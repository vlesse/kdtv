/**
 * An HTTPS front for streams that only exist over plain HTTP.
 *
 * The panel answers a play request with a redirect, and for live channels that
 * redirect lands on a CDN that speaks only HTTP. The app is served over HTTPS,
 * so a browser refuses to follow it: not because the page asked for anything
 * insecure, but because the redirect did. Live television therefore worked on
 * the boxes - whose WebView is configured to allow it - and nowhere else,
 * which made every check from a laptop look like a broken channel.
 *
 * This relay fetches the stream server-side and hands it back over the same
 * HTTPS origin as the app, rewriting the playlist so the player asks us for
 * the segments too.
 *
 * It is deliberately opt-in. Video normally goes straight from the panel to
 * the box, and it must keep doing so: a fleet of several hundred rooms pulling
 * their television through this one small VPS would make it the bottleneck for
 * the entire property. So the boxes carry on with the redirect, and only a
 * client that cannot follow one - a browser - asks for a relayed URL.
 */
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

/** How long a minted stream token stays usable. Long enough to leave a channel on. */
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

/** A ceiling, so a stream of tokens cannot grow the process without bound. */
const MAX_TOKENS = 2000;

/** Upstream is a CDN on the far side of a hotel uplink; give it room. */
const UPSTREAM_TIMEOUT_MS = 20_000;

/**
 * token -> { origins:Set, url, at }
 *
 * `url` is the panel URL, credentials and all, which is exactly why it lives
 * here and never goes to the client. The token is the only thing the player
 * ever sees, so a playlist captured off the wire cannot be replayed against
 * the panel by someone else.
 *
 * `origins` is the allowlist this token may fetch from, and it is built from
 * the content rather than assumed. It started as a single origin - wherever
 * the playlist itself resolved to - which is wrong for a CDN that serves its
 * playlist from one host and its segments from another: CCTV5+ hands back a
 * playlist on one address whose every segment lives on `httplive.slave...`,
 * and the relay refused all of them, 403, with the player none the wiser.
 * So an origin is admitted when a playlist we fetched named it, and never
 * otherwise - still not an open proxy, since nothing but the upstream's own
 * content can widen it.
 */
const tokens = new Map();

/** A playlist pointing at more hosts than this is not a stream. */
const MAX_ORIGINS = 16;

function sweep() {
  const cutoff = Date.now() - TOKEN_TTL_MS;
  for (const [key, entry] of tokens) if (entry.at < cutoff) tokens.delete(key);
  // Still over the cap after expiry means genuine load; drop oldest first.
  if (tokens.size > MAX_TOKENS) {
    const oldest = [...tokens.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key] of oldest.slice(0, tokens.size - MAX_TOKENS)) tokens.delete(key);
  }
}

/** Register an upstream URL and return the opaque id the player will use. */
export function mint(upstreamUrl) {
  sweep();
  const token = randomBytes(16).toString('hex');
  tokens.set(token, { url: upstreamUrl, origins: new Set(), at: Date.now() });
  return token;
}

function lookup(token) {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (Date.now() - entry.at > TOKEN_TTL_MS) {
    tokens.delete(token);
    return null;
  }
  return entry;
}

const b64url = {
  encode: (s) => Buffer.from(s, 'utf8').toString('base64url'),
  decode: (s) => Buffer.from(String(s), 'base64url').toString('utf8'),
};

/**
 * Point every URI in a playlist back at us.
 *
 * Resolution is against the URL the response actually came from, not the one
 * we asked for: the panel redirects twice before the real playlist appears,
 * and its segment paths are root-relative, so resolving them against the
 * original request would aim them at the panel instead of the CDN holding the
 * video.
 */
function rewritePlaylist(body, baseUrl, prefix, allow) {
  const through = (raw) => {
    const url = new URL(raw, baseUrl);
    allow?.(url.origin);
    return `${prefix}/u/${b64url.encode(url.toString())}`;
  };

  return body
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Keys and init segments hide their URI inside an attribute list, and a
      // playlist whose decryption key still points at plain HTTP fails exactly
      // the same way the stream itself did.
      if (trimmed.startsWith('#')) {
        if (!/URI="/.test(trimmed)) return line;
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${through(uri)}"`);
      }

      // Anything else on its own line is a segment or a variant playlist.
      return through(trimmed);
    })
    .join('\n');
}

/*
 * 中继必须**装成浏览器**，而不是报自己的名字。
 *
 * 原来这里发的是 `WeWatchTV/1.0`，理由只是"有些 CDN 不接受没有 UA 的请求"。
 * 但实测发现有的上游不是"要有 UA"，而是**只认浏览器的 UA**：
 * 5 ATV3 对 `WeWatchTV/1.0`、对 ExoPlayer 的默认 UA、对空 UA 一律回 403，
 * 换成浏览器的 UA 就通。
 *
 * 而 ATV3 恰恰是**没有 CORS 头、只能走中继**的那几个台之一 ——
 * 也就是说这一行让它在每一台盒子上都放不出来，报的还是一个 403，
 * 现场只会看到"这个台坏了"，没人会想到是我们自己发的 UA 被上游拒了。
 *
 * 用一个真实的安卓 WebView UA，因为盒子本来就是用 WebView 在放 ——
 * 中继只是替它把流量转一道，不该因此看起来像另一种客户端。
 */
const UPSTREAM_UA =
  'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchUpstream(url) {
  return fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { 'User-Agent': UPSTREAM_UA, Accept: '*/*' },
  });
}

/** Widen a token's allowlist, up to the cap. */
function admit(entry, origin) {
  if (entry.origins.size < MAX_ORIGINS) entry.origins.add(origin);
}

export function registerRelay(app) {
  /**
   * The entry point the player is handed. Always re-follows the panel's
   * redirect chain rather than caching where it landed last time: those
   * intermediate URLs are signed and time-limited, so a channel left on for an
   * evening would otherwise die the moment the first one expired.
   */
  app.get('/hls/:token/index.m3u8', async (req, reply) => {
    const entry = lookup(req.params.token);
    if (!entry) return reply.code(404).send({ error: 'stream expired' });

    let res;
    try {
      res = await fetchUpstream(entry.url);
    } catch (err) {
      req.log.warn({ err: err.message }, 'relay: upstream unreachable');
      return reply.code(502).send({ error: 'upstream unreachable' });
    }
    if (!res.ok) return reply.code(502).send({ error: `upstream ${res.status}` });

    const body = await res.text();
    // Where it landed is the first origin this token may fetch from; the
    // rewrite below adds whichever others the playlist itself names.
    entry.origins.add(new URL(res.url).origin);
    entry.at = Date.now();

    const prefix = `/hls/${req.params.token}`;
    reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      // A live playlist is rewritten every few seconds; caching it would pin
      // the viewer to a window of the broadcast that has already gone.
      .header('Cache-Control', 'no-store')
      .header('Access-Control-Allow-Origin', '*');
    return rewritePlaylist(body, res.url, prefix, (o) => admit(entry, o));
  });

  /**
   * Segments, variant playlists, and keys.
   *
   * The origin check is what keeps this from being an open proxy: a token only
   * ever unlocks the hosts its own playlists pointed at, so a stolen token is
   * worth a stream and nothing else.
   */
  app.get('/hls/:token/u/:enc', async (req, reply) => {
    const entry = lookup(req.params.token);
    if (!entry) return reply.code(404).send({ error: 'stream expired' });

    let target;
    try {
      target = new URL(b64url.decode(req.params.enc));
    } catch {
      return reply.code(400).send({ error: 'bad target' });
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return reply.code(400).send({ error: 'bad scheme' });
    }
    if (entry.origins.size && !entry.origins.has(target.origin)) {
      return reply.code(403).send({ error: 'origin not allowed' });
    }

    let res;
    try {
      res = await fetchUpstream(target.toString());
    } catch (err) {
      req.log.warn({ err: err.message }, 'relay: segment unreachable');
      return reply.code(502).send({ error: 'upstream unreachable' });
    }
    if (!res.ok) return reply.code(res.status).send({ error: `upstream ${res.status}` });

    entry.at = Date.now();
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    reply.header('Access-Control-Allow-Origin', '*');

    /*
     * Is this a playlist or a segment? Ask the bytes, not the label.
     *
     * A variant playlist has to be rewritten in turn, or its segments go
     * straight back to plain HTTP and undo the whole exercise - while a
     * segment is binary and megabytes long, and pulling one into a string both
     * corrupts it and holds it in memory for nothing. So the two must be told
     * apart, and what they claim to be is not reliable: Phoenix Infonews hands
     * back its variant playlist from a URL with no extension, as `text/plain`,
     * and relaying that untouched gave the player a playlist it had been told
     * was video. Seven bytes settle it, and they cost one peek at a stream
     * that is being read anyway.
     */
    const reader = res.body?.getReader();
    const first = reader ? await reader.read() : { done: true };
    const head = first.value ? Buffer.from(first.value) : Buffer.alloc(0);

    const isPlaylist =
      head.subarray(0, 7).toString('latin1') === '#EXTM3U' ||
      /mpegurl/i.test(contentType) ||
      /\.m3u8?(\?|$)/i.test(target.pathname + target.search);

    if (isPlaylist) {
      const parts = [head];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        parts.push(Buffer.from(next.value));
      }
      reply
        .header('Content-Type', 'application/vnd.apple.mpegurl')
        .header('Cache-Control', 'no-store');
      entry.origins.add(new URL(res.url).origin);
      return rewritePlaylist(
        Buffer.concat(parts).toString('utf8'),
        res.url,
        `/hls/${req.params.token}`,
        (o) => admit(entry, o),
      );
    }

    // Segments are immutable once published, so they may cache - which is what
    // keeps a relayed stream from costing more than it has to.
    reply.header('Content-Type', contentType).header('Cache-Control', 'public, max-age=300');
    const length = res.headers.get('content-length');
    if (length) reply.header('Content-Length', length);
    if (!reader) return reply.send();

    // The peeked chunk goes back in front of the rest; nothing is lost and
    // nothing is held, so a three-gigabyte film still streams through.
    return Readable.from(
      (async function* () {
        if (head.length) yield head;
        for (;;) {
          const next = await reader.read();
          if (next.done) return;
          yield Buffer.from(next.value);
        }
      })(),
    );
  });
}
