# Production deployment — ott.example.com

> 文中的 `<APP_HOST>`、`<PANEL_HOST>`、`<PANEL_PATH>` 是占位符 —— 真实地址在本机的
> `deploy/SECRETS.local.md`，那个文件不进 git。面板的后台路径本身就是一道锁，
> 服务器 IP 也没有理由公开。


Live since 2026-09-09.

```
机顶盒 ──┬─ https://ott.example.com/          → BFF + TV app   (GCP <APP_HOST>)
         ├─ https://ott.example.com/stream/  → XUI 面板 302   (GCP → <PANEL_HOST>)
         └─────────────────────────────────────→ 上游 CDN 直连
运维   ──── https://ott.example.com/collector/ → 采集器操作台
```

Two machines. **<APP_HOST>** (GCP, shared with several other projects) runs
the BFF, the TV bundle and the collector. **<PANEL_HOST>** (DigitalOcean,
Singapore) is the existing live XUI panel — untouched except for the additions
listed below.

## What went onto the panel

Additive only. No existing row was modified, so no current customer's lineup
changed.

| Thing | Value |
|---|---|
| Bouquet | `<VOD_BQ>` — everything the collector writes lands here |
| Line | `<LINE_USER>`, 500 connections, bouquets `[<LIVE_BQ>,<VOD_BQ>]` |
| DB user | `collector`@`<APP_HOST>`, SELECT/INSERT/UPDATE/DELETE on `xui` only |

The live bouquet (the 91 channels) is shared with the existing lines and
was not edited — the fleet line simply subscribes to it alongside the new one.

## Why playback is proxied

`XUI_PUBLIC_BASE` points at `https://ott.example.com/stream`, not at the
panel's IP. This looks like proxying video, and it is not: **every stream on
the panel is `direct_source=1`**, so the panel only ever answers with a
302 and the box fetches the video straight from the upstream CDN. nginx carries
a redirect header, not a video stream.

It buys two things:

1. The line password travels in the URL. Over plain HTTP it would be in the
   clear on every hotel and dormitory network the boxes sit on.
2. The page is HTTPS. On-demand upstreams are HTTPS too, so routing the first
   hop through TLS makes film and series playback work in an ordinary browser.

Live channels still end at `http://cdn-live.example-upstream.net:8807/...` — that CDN has no TLS,
and no amount of proxying the *first* hop fixes the redirect's destination. The
APK's WebView is built with `MIXED_CONTENT_ALWAYS_ALLOW` and follows it; a
desktop browser refuses. That is what `relay.js` is for, and live now plays in
a browser too — see **Live over HTTPS: what was actually wrong** further down.
The relay is opt-in and browser-only: **the boxes keep taking the redirect, so
the fleet's video never touches this VPS.**

## Pointing at a different panel

Nothing here is XUI.one-specific. Content comes over the **stock Xtream Codes
API** — `player_api.php`, plus the `/live/ /movie/ /series/` URL shapes — so any
Xtream-compatible panel works. Four places carry the panel's address, and
missing one means no picture:

| Where | What |
| --- | --- |
| nginx vhost, `location /stream/` | `proxy_pass` **and** `proxy_set_header Host` |
| `.env` → `XUI_BASE` | how this service reaches the panel |
| `.env` → `XUI_PUBLIC_BASE` | usually unchanged — it points at `/stream/` above, not at the panel |
| collector `.env` → `XUI_DB_HOST`, `PANEL_REFRESH_CMD` | see below |

Then on the panel itself: its **own** `url`/`port` setting, and the
`servers` row where `is_main=1`. Those two are what `server_info` reports and
what playback URLs are built from — leave them and every box still calls the
old address.

Two things do **not** move:

1. **The collector only speaks XUI.one.** It writes the panel's MySQL tables
   directly and then triggers the panel's own `cache_engine.php`; it does not
   use the API. Pointing KDTV at someone else's panel means giving up
   collection — their catalogue, their call.
2. **One panel per KDTV server.** `config.xui.base` is global. *Lines* are
   per-property; the panel address is not. Per-property panels means moving
   the base into the properties table — a code change, not a setting.

Also worth knowing before promising a room count: a property's rooms all share
**one line**, so the line's `max_connections` is the ceiling on simultaneous
viewers. Ours is set to 500. A line bought from an IPTV reseller is typically
1–5, which fails on the second room.

## Operating it

```bash
cd /opt/wewatch-ott
docker compose ps
docker compose logs -f bff
docker compose up -d --build       # after uploading new source
```

Layout on the server:

```
/opt/wewatch-ott/
  docker-compose.yml
  .env                 # credentials, chmod 600
  ott-frontend/        # source; the image builds the web bundle from it
  xui-collector/
  data/bff/            # device bindings, room service orders
  data/collector/      # sources, category mappings, import log
```

nginx: `/etc/nginx/sites-available/ott`. Certificate is Let's Encrypt via the
certbot already on the box, renewing on its own timer.

### Shipping a new TV UI

This is the whole point of the thin-shell design — no box is touched:

```bash
# from the workstation
tar czf web.tgz --exclude=node_modules --exclude=dist ott-frontend/
# upload to /root, then on the server:
cd /opt/wewatch-ott && tar xzf /root/web.tgz && docker compose up -d --build bff
```

The APK only needs rebuilding for native changes. It has one address baked in.

### Where the APK is downloaded from

The boxes are not always reachable by adb, so the installer is served off the
same domain as the UI:

```
https://ott.example.com/media/tv.apk
```

It is simply a file dropped into the media volume
(`/opt/wewatch-ott/data/bff/media/tv.apk`), not an upload - so it has no row in
the `media` table, does not appear in the console's media list, and cannot be
deleted from there by accident. `/media/` is static-served, and `.apk` already
maps to `application/vnd.android.package-archive`, so an Android browser offers
to install it rather than saving it somewhere the user has to go and find.

One trap: `/media/` is sent with `cache-control: immutable` for a year, which is
right for uploaded images and wrong for a file that gets replaced. **Publish a
new build under a new name** (`tv-1.0.1.apk`) rather than overwriting `tv.apk`,
or a box that already fetched it will keep installing the old one.

```bash
scp -i ~/.ssh/<key> shell/app/build/outputs/apk/debug/app-debug.apk   root@<APP_HOST>:/opt/wewatch-ott/data/bff/media/tv-<version>.apk
```

## Collector

Console at `/collector/`. It writes to the panel over the internet, so a run is
much slower than it was locally — about five minutes per 280 titles, against
forty seconds on a LAN. That is round-trip latency, not a fault.

`PANEL_REFRESH_CMD` is deliberately empty: this host has no shell on the panel,
so collected content becomes visible when the panel's own `cache_engine` cron
next runs, within five minutes.

Automatic collection is on at every 6 hours over a 72-hour window.

## Identity has to arrive before the page's scripts

The shell registers a `WeWatchShell` JavaScript bridge **before the first
load**, and the web app reads the device id from it synchronously at boot.

The first build pushed `window.__DEVICE_ID__` from `onPageFinished`, which
fires *after* the page's scripts have run. So the box introduced itself under
the browser fallback id, then started sending the Android one, and every
content endpoint answered 403 — live TV and the catalogue came up empty while
room service (the one endpoint that needs no line) worked fine. That is what a
"black screen" on the box actually was.

The client also re-handshakes once and retries on a 403, so a box whose id
changes for any other reason — a shell upgrade, cleared storage — recovers by
itself instead of showing an empty shelf.

## Languages

中文 / English / ខ្មែរ / Indonesia, switched from the pill in the top bar and
remembered per box. 中文 is the default when the box's own locale says nothing
useful.

The Khmer subset of Noto Sans Khmer (57 KB) is served from this host with a
`unicode-range`, because cheap Android boxes routinely ship without Khmer
glyphs and the fallback is a row of tofu. Viewers reading the other three
languages never download it.

**The Khmer strings are a first pass and should be read by a native speaker**
before this goes in front of residents.

## The launcher

The home screen is a hotel-TV launcher: a gradient status bar (welcome, room,
clock, date and weekday, weather, language) over a full-bleed background, and a
gradient band low on the screen holding four evenly spread tiles — TV Live, VOD,
Room Service, About us. Browsing lives one level down, and Back climbs out of
any section.

**Both bars are neutral grey and mostly transparent** (0.32–0.66 alpha), with
plain white hairline edges. That is deliberate rather than timid: a coloured
bar competes with whatever photo the property uploads, and grey works over all
of them — which is the whole point of a launcher anyone can re-skin from the
console. The band's two hairlines are what make the four tiles read as one
object instead of four things floating on a photo, and what keeps the labels
legible over a bright picture.

### Motion

This screen is on for hours in a room somebody lives in, so the budget is
small: the picture drifts (a 48-second Ken Burns, alternating so there is no
jump back to frame one), the four tiles arrive left to right on load, and a
highlight crosses the band every eleven seconds. Focus lifts a tile and fills
it.

The drift is **scale(1) → scale(1.04)** and no more. A wider range looks better
in a design tool and worse on the wall: the source photo is usually already
smaller than the panel, so every extra percent of scale is another percent of
upscaling stacked on top. Starting at exactly 1 means half of each cycle sits
at native size.

Everything that loops moves `transform` or `opacity` only, which the compositor
handles without repainting — this runs on a 1 GB Android box, not a phone. All
of it sits behind `prefers-reduced-motion`, so a box configured for reduced
motion gets a still launcher with every layout intact.

One trap worth writing down: the entrance animation is on a `.tile-slot`
wrapper, not on the tile itself. An animation with a fill mode outranks
ordinary declarations, so a tile that animated *itself* in could never be moved
by `:focus` afterwards — the focus lift would silently do nothing.

### Background resolution

The console warns when an uploaded image is narrower than 1920px. This is the
most common disappointment here: a picture that looks sharp on a laptop is
being upscaled onto a 1080p panel, and no amount of re-encoding puts detail
back. The photo layer carries a `saturate(1.24) contrast(1.09)` grade, which
stops a soft source looking washed out but is not a substitute for pixels.

The grade lives on `.launcher-photo` rather than on `.launcher-bg` on purpose:
`filter` applies to the whole subtree, so grading the backdrop would drag the
legibility scrim through the same correction and undo it.

Weather is Open-Meteo — no key, no attribution beacon. One reading is cached
for half an hour and shared by every box, since it is the same weather.

The tile icons are drawn as SVG paths rather than shipped as artwork, so they
stay crisp at any tile size, recolour on focus, and cost nothing to download.

## The admin console

`https://ott.example.com/admin/`. One page, password in `ADMIN_TOKEN`.

It exists so a property can change what its televisions look like without a
deploy: upload a photo or a video loop, pick one, done. Changes take effect the
next time a box shows its launcher — no APK, no container rebuild.

| Section | What it does |
|---|---|
| 当前背景 | Live preview of what the boxes are showing; one button restores the built-in gradient |
| 上传图片或视频 | Drag-and-drop or picker, with an upload progress bar |
| 已上传的素材 | Library — set as background, or delete (removes the file too) |
| 用外部链接 | Point at an https URL instead of uploading |
| 文字 | Welcome line, property name, support contact |

Everything it changes lands in the `settings` table, which **overrides** the
matching environment variable. `HOME_BACKGROUND_URL` and friends are still read
as the default, so a property configured before the console existed keeps
looking exactly as it did until someone changes it here.

### Things worth knowing

- **Uploads land in `data/bff/media/`**, on the same mounted volume as the
  database, so they survive a container rebuild. Filenames are generated
  server-side; a client-supplied name never reaches the filesystem.
- **The type allowlist is by extension**, not by the declared mime — JPG, PNG,
  WebP, GIF, MP4, WebM, MOV, M4V. Anything else is refused.
- **nginx needs `client_max_body_size`.** Its default is 1 MB, which would 413
  every video upload. The vhost now sets 220 MB, above the service's own 200 MB
  cap so the service is the one that reports the limit.
- **An http:// external URL is rejected outright.** The launcher is served over
  HTTPS, so an http background is mixed content and simply never appears. The
  console says that rather than storing a setting that does nothing.
- **A video background is a real cost on cheap hardware.** Keep a loop under
  ~30 seconds and ~10 MB; the console says so too.
- **Deleting the file that is currently in use resets the background to the
  gradient**, rather than leaving every television pointed at a 404.
- Missing files under `/media/`, `/admin/`, `/assets/` and `/api/` now return
  404. They used to fall through to the single-page handler, so a deleted
  background answered `200 text/html` and the box sat trying to decode a web
  page as a photo.

### Background variables (still the fallback)

| Variable | Effect |
|---|---|
| `ADMIN_TOKEN` | Console password. Unset, one is generated on first boot and written to the log. |
| `MAX_UPLOAD_BYTES` | Per-file upload cap, default 200 MB |
| `HOME_BACKGROUND_URL` | Default background when the console has not set one |
| `PROPERTY_NAME` | Shown on the About screen |
| `SUPPORT_CONTACT` | Phone or extension on the About screen |
| `WEATHER_LAT` / `WEATHER_LON` | Defaults to the Morowali park |

## Branding: what a property can change without a deploy

The console's 品牌/外观 and 自定义 CSS sections. Everything here lands in the
`settings` table and is served two ways: as fields on `/api/app/home`, and as a
generated stylesheet at `/theme.css`.

| Setting | Where it shows |
|---|---|
| Home background | Behind the launcher — image or video |
| Splash image | The boot screen, before the app has drawn anything |
| Loading image | Behind the player while a stream is being fetched |
| Logo | Boot screen and About |
| Accent colour | `--accent`, the token the whole UI already keys off |
| Custom CSS | Anything the above does not cover |

### Why /theme.css is a link, and where it sits

It is a `<link>` rather than a script injection so it arrives with the rest of
the CSS instead of after first paint — a theme applied late is a visible flash
of the defaults on every boot.

It is the **first element in `<body>`**, not in `<head>`, and that placement is
load-bearing. Vite appends the app's own stylesheet to the end of `<head>`, so
a theme linked above it would lose every tie in the cascade — precisely
backwards for an override. From the top of `<body>` it is still fully
render-blocking, and it wins. That is what lets operator CSS work without
`!important`, the way Jellyfin's Custom CSS field does.

The response carries `X-Content-Type-Options: nosniff`. The body contains
operator-authored text, and this guarantees no browser ever reconsiders it as
anything but CSS.

### Guards

- Images must be `https://` or a `/media/` path. An `http://` URL is refused
  outright, because the launcher is HTTPS and it would silently never appear.
- Splash, loading and logo are stills. For an uploaded file the type is known,
  so a video is refused there by name rather than turning up as a black screen.
- The accent must be `#rgb` or `#rrggbb` — this value is pasted into a
  stylesheet, so anything else is rejected rather than escaped.
- Custom CSS is capped at 20 000 characters and has `</style>` stripped. It is
  otherwise left alone: CSS is confined to presentation, it is served as its
  own `text/css` response with no HTML context to escape, and the person typing
  it already holds the console password.

## The player

Rewritten around recovery, because an IPTV source is not a file on a disk. The
old core gave up on the first fatal error of any kind, which is the single
thing that made it worse than the open-source players it sits beside.

**The hls.js ladder**, which is the documented one and was entirely absent:
a fatal network error retries `startLoad()` with exponential backoff (1s, 2s,
4s..., six attempts); a fatal media error tries `recoverMediaError()`, then
`swapAudioCodec()` + recover, and only then gives up. Non-fatal errors are left
alone - hls.js resolves those itself, and reacting would restart a stream that
was never broken.

**The retry budget resets on recovery**, not just at load. A channel left on all
evening drops and recovers many times; a budget that only counted down would
eventually fail a stream that had been fine for hours.

**A stall watchdog**, for the failure hls.js cannot report: segments keep
arriving, the buffer keeps filling, and the element simply never advances. No
progress for 12s while not paused, ended or seeking triggers a reload from the
live edge.

**The native path has recovery at all now.** That is the path the boxes take -
`video.src = url` with nothing watching it - so until this, the hardware that
actually ships had none.

**Per-kind tuning.** Live: 12s buffer, 30s back-buffer, `liveSyncDurationCount`
3. On demand: 30s buffer, 60s back-buffer. Both cap the level to the player
size, because a 4K variant does not decode on this hardware, and both cap
back-buffer, which is what stops a three-hour film growing until a 1GB box
kills the page.

**Zapping is debounced and generation-guarded.** Six presses of Down used to
fire six requests whose replies raced; whichever landed last won, which was
rarely the channel named on screen. Now the name and curtain update instantly,
the request is held 350ms, and a reply for a channel the viewer has left is
dropped. Verified: 6 presses, 1 request.

**Retry re-tunes rather than replaying.** A live URL is a redirect chain of
signed, time-limited hops with a relay token in front of it. By the time a
viewer has read a failure and pressed the button, the URL that failed is
precisely the one that cannot work. Both players now go back for a fresh one.

### The engine: what the boxes were actually running

Verified on a 4K Android TV emulator (Android 16, WebView 143) rather than
reasoned about, and the reasoning had been wrong.

Chromium grew its own HLS demuxer on Android around WebView 125. So a box
answers `canPlayType('application/vnd.apple.mpegurl')` with "maybe", and the
old engine order - native first, "because it keeps decoding on the hardware
path" - handed it every stream. **It cannot play any of them.** Live and film
alike died on the first manifest with `DEMUXER_ERROR_COULD_NOT_PARSE`, which is
what the grey placeholder and "信号中断，正在重连" actually were. Every stream
this panel mints is a 302 onto a CDN, and its demuxer does not survive the hop.

The order is now: **hls.js wherever MSE runs, native only where it does not**
(iOS Safari, old WebViews). Decoding still lands on `c2.*.h264.decoder` - MSE
does not mean software decoding - and both live and on demand play on the box.

There is deliberately no "fall back to native" step. On the only hardware that
has both engines, native is precisely the one that cannot open these streams;
all it bought was half a minute of "reconnecting" before the relay got a turn.

### What hls.js costs, and what pays for it

Reading playlists over XHR means CORS applies, and the native demuxer never
cared. Of 91 channels: 84 come off `cdn-live.example-upstream.net` with `Access-Control-Allow-Origin: *`,
4 are dead upstream anyway, and **3 send no CORS header at all** - a playlist no
page can read, however the WebView is configured.

Those three fall back to the relay, which already existed for browsers:

- The client asks - `?relay=1` - only after the direct URL has failed. The
  fleet keeps taking the direct redirect for the other 88 channels, so this
  host still is not in the video path for normal viewing.
- `/api/vod/play/:kind/:id` accepts the same flag now; it did not before.
- A manifest that will not load fails **fast** (`manifestLoadingMaxRetry: 2`)
  rather than spending fifteen seconds of exponential backoff establishing what
  a CORS refusal already said. Segments keep the patient settings.

Three bugs surfaced in getting those three channels to play, and all three were
in code that had only ever been exercised by a browser on a well-behaved CDN:

1. **The relay's origin guard was too tight.** It allowed one origin - wherever
   the playlist resolved to. CCTV5+ serves its playlist from one host and every
   segment from another, so the relay refused its own rewritten URLs, 403. The
   allowlist is now built from the content: an origin is admitted when a
   playlist we fetched named it. Still not an open proxy - only the upstream's
   own playlists can widen it - and capped at 16.
2. **A playlist served as `text/plain` with no extension was relayed as a
   segment.** Phoenix Infonews does exactly that, so the player got a playlist
   it had been told was video. The relay now sniffs the first seven bytes for
   `#EXTM3U` and pushes the peeked chunk back in front of the stream, so a
   three-gigabyte film still streams through without being buffered.
3. **`load()` did not clear `video.src` before attaching MSE.** Harmless while
   the two engines were mutually exclusive; once one load could follow another
   on a different engine it left two players arguing over one element -
   segments arriving, nothing ever playing, curtain never lifting.

A relayed stream is only as fast as this VPS's link to the viewer. Measured on
one 10 Mbps channel: VPS -> CDN 84 Mbps, VPS -> a test box in China 0.9 Mbps,
which cannot play it. The relay is not the bottleneck there, the route is, and
the three channels that need it still want checking from the property itself.

### Live over HTTPS: what was actually wrong

Not what the earlier note said. The stream URL handed to the player is HTTPS
and same-origin; it is the panel's **302** that lands on `http://` - live CDNs
speak plain HTTP, on-demand ones happen to speak HTTPS, which is why films
played in a browser and channels did not.

The boxes were never affected: the shell sets `MIXED_CONTENT_ALWAYS_ALLOW`, so
a WebView follows that redirect. Every "live is broken" observation came from a
desktop browser.

`relay.js` closes it for everything else. `/api/play/:id?relay=1` mints an
opaque token for the panel URL and returns `/hls/<token>/index.m3u8`; the relay
follows the redirect chain server-side and rewrites every URI in the playlist -
segments, variants, and `URI="..."` attributes on keys and maps - to come back
through the same HTTPS origin.

- The request is **opt-in from the client**: `needsRelay()` is true only when
  the shell bridge is absent. Boxes keep taking the direct redirect, so fleet
  video still never touches this host.
- The panel URL, credentials and all, stays server-side. The token is all the
  player ever sees.
- A token only unlocks the origin its own playlist resolved to, so it is not an
  open proxy. Verified: a token pointed at another host returns 403.
- Tokens live in memory, so restarting the BFF drops browser streams. Boxes are
  unaffected, and the retry button re-mints.
- **`maxParamLength`** had to be raised from the router's default of 100: an
  encoded CDN URL is roughly 250 characters, so every segment quietly missed
  its route and came back 404 from the catch-all - a stream that fetched its
  playlist perfectly and then played nothing.

## Two routes that were open on a public domain

`GET /api/device/list` answered an unauthenticated GET with `SELECT * FROM
devices` - 31 rows carrying `line_user` and `line_pass` in clear, plus every
pairing code, MAC and room number. Anyone with the domain had the IPTV line.
`POST /api/device/bind` let anyone point any box at any line.

Both are now behind the console token, and the line password no longer appears
in any response - an operator gets `line_user` and a `bound` flag, which is all
either question needs. Neither route is called by the television app or the
console, so nothing broke.

## Video backgrounds

Supported and tested end to end. Upload an MP4 or WebM, press 设为背景; the
launcher plays it muted, looped, `object-fit: cover`, behind everything else.

What to hand a customer who asks for one:

| | |
|---|---|
| Resolution | 1920×1080 (a 4K panel upscales it, but 4K video on a 1GB box does not decode) |
| Length | 15–30 s, seamless loop |
| Size | under 10 MB |
| Audio | **none** — it is played muted, so an audio track is bytes nobody hears |
| MP4 export | **must** be faststart / "Web Optimized" |

The console checks every one of these at upload time and says which failed.

### faststart is the one nobody knows about

An MP4 keeps its index — the `moov` atom — either before the media data or
after it. After, and a player cannot show one frame until the whole file has
arrived: a 40 MB loop becomes a minute of black instead of a second. Handbrake
and ffmpeg both default to putting it last unless told otherwise
(`-movflags +faststart`). `startsFast()` in `media.js` walks the top-level
atoms and reports which came first; WebM and anything unrecognised report
`null` and say nothing rather than guess.

### Three things a video background broke that an image never did

All fixed, all worth understanding before touching this code again.

**`remove-hook` was never dispatched.** Three screens registered teardown on it
— the launcher's clock, the player's hls.js instance, VOD's progress save — and
`mount()` only ever called `replaceChildren`. None of it had ever run. With an
image that is an invisible timer leak; with a video it is a decoder still held
after the guest has pressed a channel, and a cheap box has one or two. `mount()`
now dispatches it on the outgoing view.

**The autoplay watchdog gave up too early.** `keepPlaying()` removed every
retry listener on the first `playing` event. But a loop that started can still
be stopped later — a browser suspends muted video while the page is hidden, and
a box in a room is hidden every time the guest changes input or the panel
sleeps. Nothing resumed it, and the result was one frozen frame for the rest of
the stay. The watchdog now lives as long as the element, resuming on `pause`
and on `visibilitychange`, and only ever while the page is visible — chasing
playback into a hidden page is how that turns into a play/suspend spin.

**The photo grade was running on video.** `saturate(1.24) contrast(1.09)` sat on
`.launcher-photo`, which is the video's parent, so it cost a full-resolution
filter pass every frame — and oversaturated footage that was already graded.
Scoped to `[data-on='image']`.

Media is now served `max-age=365d, immutable`: a stored file is never rewritten
(changing the background writes a new UUID), so a 10 MB loop is fetched once per
box rather than re-validated.

## The remote

The player answers a television remote, not a web page, and the three habits
below are the ones a guest arrives with. None is discoverable and none needs to
be; they are muscle memory, and a box that ignores them feels broken however
good its menus are.

| Press | What happens |
|---|---|
| Up / Down | Previous / next channel **by channel number**, wrapping |
| ChannelUp / ChannelDown / PageUp / PageDown | The same — cheap remotes send all three |
| Digits | Builds a channel number on screen; tunes after 2s, or immediately on OK |
| OK, while the overlay has faded | Brings the overlay back and nothing else |
| Back | Cancels a half-typed number, else closes the list, else leaves |

Zapping order is by `num`, not by the order the panel answered in, and the
channel list shows the number beside each row — without that, typing a number
is guesswork. Numbers are not contiguous in a real bouquet (29, 30, 32, 33,
44, 51…), so "type 55" and "press Down twice" have to agree, and they do.

Five rapid presses still produce **one** request: the name and the curtain
update on the keypress, the request is debounced 350ms behind it, and a stale
reply is dropped by generation counter.

### Why the key listener is on the document, in capture

This was a real bug, found by testing rather than by reading.

The handler used to live on the player's own root element, which only hears a
key when focus is somewhere inside it. Focus does fall out — a press on the
picture itself, an element replaced underneath it (the channel list is rebuilt
on every tune), a curtain button that vanishes when the stream recovers. After
that the box stopped answering the remote **entirely**: no zapping, no number
entry, not even the overlay coming back. The only way out was Back.

It now listens on `document` with `capture: true`. Capture matters: the D-pad
navigator also listens on the document and registered first, so in the bubble
phase it would move focus before the player ever saw the key. From capture the
player decides first, and passes a key on — to the channel list, say — only
when it has no use for it. Both players do this; both remove the listener in
their `remove-hook`.

Verified live: with `document.activeElement` forced to `<body>` and the overlay
hidden, one Down zapped AXN → CCTV5, brought the overlay back, restored focus
to a real control, and played at 1920×1080. Before the fix that press did
nothing at all.

## The restricted section

Off. Not "off by default" in the sense of a checkbox someone forgot — the
feature ships disabled, with no PIN, and with zero rooms entitled, so deploying
it changed nothing for any of the 31 boxes in service.

Three separate gates, and only the third is a PIN:

1. **The property carries it.** `adult.enabled`, a master switch in the
   console. With it off, the categories are ordinary categories again.
2. **The room is entitled.** `devices.adult_allowed`, per box, default 0. A
   dormitory or a family floor is simply never given the section, and no PIN
   conjures it up. A box that is not entitled is never told the tile exists.
3. **Someone knows the PIN.** 4–8 digits, stored as a scrypt hash — never
   returned by any route, including to the console.

### What is restricted is chosen, not guessed

Matching category *names* was the original design, and it failed the first time
real stock arrived. A panel gained **29 adult categories in one afternoon** -
伦理影片, 日韩无码, 黑料网曝, 动漫精品, 国产精品 - and the keyword list caught
**none** of them. Chinese resource sites do not name things "adult". Worse, the
master switch was off at the time, and off means nothing is filtered at all, so
2 828 titles went straight to the front of every room's on-demand shelf and
pushed the ordinary catalogue below the fold.

So the rule is now an identity, not a guess. The console reads the panel's own
categories through a bound line and the operator ticks them; a tick is stored
as `vod:43`, `series:30`, `live:17` in `adult.categoryIds`. A ticked category is
restricted whatever it is called and whatever it is renamed to.

- **Films and series number their categories separately**, so the namespace has
  to travel with the id. `/api/vod` therefore settles `adult` *before* it
  collapses movie and series categories by name - after the collapse the id is
  gone and 动作片 the film category and 动作片 the series category are one row.
- **Keywords survive as the safety net**, for a bouquet that appeared since
  anyone last looked. The console labels those matches so an operator can tick
  them in one press, but nothing is restricted by keyword alone that the
  operator has not also been shown.
- **Restricted shelves sort last**, in live and on demand alike, even for a
  room that may see them. Twenty-nine of them arriving at the top is what made
  this visible in the first place.
- **Rooms can be entitled in bulk.** "Whoever I want to see it, sees it" is a
  per-room answer given 31 times, and doing that one checkbox at a time is the
  thing an operator stops doing halfway.

Verified on the box, with 29 categories ticked, a PIN set and one room
entitled: a room that is not entitled gets 14 categories / 861 titles and no
tile; the entitled room after its PIN gets 43 / 3 689 with the restricted
shelves last. Guessing a restricted id gets 403 on detail and on play; the
unlock token works on the box that earned it and 403 on any other.

### The console was dead for a day

Worth recording because the check that missed it looked convincing.

The previous deploy shipped `index.html` with a **raw newline inside a
single-quoted JavaScript string** - `join('` / `');` split across two lines,
from a `
` that a shell heredoc had already turned into a real newline. That
is a `SyntaxError`, and a classic `<script>` with a syntax error does not
partially run: **nothing** in the console worked, login included.

It was "verified" by grepping the served HTML for the element ids it should
contain. They were all there. HTML being present says nothing about whether the
script parses. The check that would have caught it is one line:

```bash
node -e "const s=require('fs').readFileSync('bff/src/admin-ui/index.html','utf8');new Function(s.match(/<script>([\s\S]*?)<\/script>/)[1]);console.log('parses')"
```

### Why the filtering is server-side

Hiding a category in the interface stops nobody. The stream ids are sequential
and the API is a public domain away, so a locked box is not merely *shown*
less, it is *told* less: restricted categories and their channels are stripped
from `/api/channels` and `/api/vod` before the answer leaves the process, and
`/api/play`, `/api/vod/:kind/:id` and `/api/vod/play` refuse a restricted id
outright even when it was guessed.

Episodes needed their own pass. An episode id belongs to no category at all, so
a restricted series whose listing was hidden would still have handed over every
episode to anyone asking by number. The mapping only exists in the panel's
per-series detail, so that is walked once — for the restricted series only —
and cached with the rest.

The guard **fails closed**: if the panel cannot be reached to work out what is
restricted, a locked device is refused rather than served.

### The cache bug this had, and how it showed up

`restrictedIds()` caches for five minutes because it costs six upstream calls.
The first version did not invalidate on a settings change, so adding a keyword
filtered the *listing* immediately while leaving *playback* open for the next
five minutes — invisible from the console, and exactly the wrong way round.
Caught in testing; `invalidateRestricted()` is now called from the admin route.

### Matching

Built-in substrings, case-insensitive: `adult`, `xxx`, `18+`, `+18`, `porn`,
`erotic`, `sex`, `for men`, `成人`, `情色`, `色情`, `18禁`, `dewasa`. An
operator's own keywords extend that list; they can never shrink it. So a
bouquet called 午夜剧场 needs a keyword, and one called `XXX Adult` does not.

### The unlock

**OK on the remote submits the PIN.** Left to the browser it activates whatever
button holds focus - the on-screen "1" - so a guest who typed the PIN on the
number keys and pressed OK silently got a fifth digit and a wrong PIN. Back
deletes. The on-screen pad is for rooms whose remote has no number keys at all.


- A token bound to the device that earned it — lifting it to another box is a
  403 (verified).
- 30 minutes, **not** refreshed on use. An unlock is a window, not a rolling
  session.
- Held in memory in the TV app, never in localStorage. A guest checks out, the
  next one switches on, the app reloads — and reloading is the lock.
- Five wrong PINs per device → ten-minute lockout, counted per device so one
  room fumbling cannot lock the building. A correct PIN during a lockout is
  still refused (verified).

### Turning it on for a property

In `/admin/` → 成人板块: set a PIN, tick the rooms, then switch the section on.
The console refuses to arm it without a PIN, because enabled-with-no-PIN is a
tile anyone can walk through.

## The boot screen

Three layers, and it is worth knowing which is which:

1. **The Android window** (`res/drawable/boot_background.xml`) — the fraction of
   a second before the WebView paints. A gradient, not an image: anything baked
   into the APK would flash the *old* branding for a property that changed
   theirs in the console. Changing this needs an APK.
2. **The web boot screen** (inline in `index.html`) — the property's photo,
   logo and name, with pulsing dots. Inline because a stylesheet or a script
   would each add a round trip to the very gap being covered.
3. **The launcher**, once `hello` and the channel list are in.

The web boot screen paints from `localStorage`, not from the network. Fetching
its own image would put a round trip inside the gap it exists to cover, so it
shows what the *previous* launch cached and rewrites the cache on the way past.
The first launch after a branding change still gets the gradient; every launch
after that is instant — and a box in a room reboots far more often than its
branding changes.

The old in-app "connecting" spinner is gone on first launch: the boot screen
already covers that wait, and stacking a second one on top only added a
flicker. A *retry* still gets one, because by then the boot screen is gone.

## The player curtain

Between pressing a channel and the first frame there is a real wait — the BFF
answers, the panel redirects, the CDN opens a connection, the player pulls a
manifest and then a segment. Left alone that is several seconds of black, which
on a television reads as a broken box rather than a loading one.

So it is covered: the property's loading image, the name of the channel or film
being tuned to, and a line of status. Three states, and the distinctions matter:

- **loading** — full curtain. Raised when the viewer presses, not when the
  request returns; the wait starts at the keypress.
- **buffering** — a stall *after* playback has begun gets a small corner
  indicator instead. A full curtain over a two-second rebuffer hides video that
  is about to come back, which is worse than the stall.
- **failed** — the curtain **stays up** and says why, in amber. Dropping it on
  an error would hand the viewer a black screen with no explanation, which is
  the exact failure the curtain exists to prevent. Fatal hls.js errors route
  here too, not just to a toast that fades off a black screen.

## Verified working

Checked against the live domain on 2026-09-09:

- TLS: A record already pointed at the box; certificate issued, HTTP 301s to
  HTTPS, expires 2026-12-08 and auto-renews
- A box calling `/api/device/hello` is activated onto the default line and
  gets 91 live channels in 4 categories
- **A collected film plays in the browser at 1920x1072 over end-to-end HTTPS**
- Panel-hosted channel logos are rewritten onto the TLS origin — zero mixed
  content warnings remain for images
- Collector reaches the panel's MariaDB from GCP; 280 titles imported with no
  failures, panel load stayed at 0.00–0.06 and free memory moved by 35 MB
- APK rebuilt (3.3 MB) with the production portal, `WeWatchShell`,
  `addJavascriptInterface`, `setMixedContentMode` and the origin guard all
  compiled in, leanback activity intact
- The 403 self-heal reproduced end to end: a device id the server had never
  seen returns 403 to a bare fetch and still renders all 91 channels through
  the app
- All four languages render on the live domain, Khmer face reports `loaded`,
  and nothing clips — checked down to a 375px handset
- Launcher: all four tiles open their section and Back returns to the launcher
  from each — 91 channels, 845 titles, 11 service items, 4 About rows

## Live TV: what is and is not established

Measured on 2026-09-10, after the identity fix:

- The box is no longer 403ing. It loads the channel list and reaches
  `/api/play/<id>`, so it gets as far as being handed a playback URL.
- The live upstream is alive: following the panel's redirect returns a valid
  HLS playlist, and it sends `Access-Control-Allow-Origin: *`.
- On-demand plays on the box; live does not.

The one structural difference is the scheme. VOD redirects to
`https://cdn-vod.example-upstream.com/...`; live redirects to
`http://cdn-live.example-upstream.net:8807/...` while the page is HTTPS. That makes mixed content
the strongest remaining suspect — but it is a suspect, not a proven cause,
because the APK is built with `MIXED_CONTENT_ALWAYS_ALLOW` and that is meant
to permit exactly this.

Adding an HTTPS source to the panel settles it in one test: if an HTTPS
channel plays and an HTTP one does not, it is mixed content, and the fix is to
serve the portal itself over HTTP to the boxes (TLS stays on for the collector
console and browsers).

### Adding channels to the panel

`http://<PANEL_HOST><PANEL_PATH>` — also `<PANEL_PATH_2>` and `<PANEL_PATH_3>`; the
panel has no fixed admin path, only these access codes.

A new stream is invisible to the fleet until it is ticked into a bouquet the
default line carries — **the live bouquet or the VOD bouquet**. After
that the panel's own cache cron picks it up within five minutes.

## Worth knowing

- **The panel's MariaDB is open to the internet.** `ufw` is inactive on
  <PANEL_HOST> and 3306 accepts connections from anywhere; it already had
  remote grants for two AWS addresses before this work. The new account is
  pinned to `<APP_HOST>`, but the port itself should be firewalled to just
  the addresses that need it.
- **The panel is a 2 GB box with ~560 MB free** and it now carries roughly
  fifty times the streams it did. It was unbothered by the first few hundred
  titles; watch it before collecting tens of thousands.
- The GCP box had **7.4 GB free disk** after the images were built, and about
  20 GB of reclaimable Docker build cache from other projects if it gets tight.

## Scenery behind the lists

The on-demand list and a film's details used to sit on flat black, which reads
like a file manager rather than a television.

- The list borrows the property's own photograph - the one already configured
  for the launcher - blurred and dimmed until it is scenery. A configured
  *video* contributes its poster frame only: a second decoder on a box that has
  one or two is not worth a background.
- A film's details use the film's own artwork, faded in when the image has
  actually decoded. A backdrop that pops in half-drawn is worse than none, and
  a title with no artwork simply keeps the dark.

Both use the same trick, which is the part worth remembering: a full-screen
`filter: blur()` is charged per painted pixel, and on a 4K panel driven by a box
with a stream to decode that is a bill nobody wants. So the layer is rasterised
at a quarter of the screen in each direction - a sixteenth of the pixels - and
scaled back up, which is free. Radii are written in pre-scale pixels, so
`blur(7px)` lands as 28 on screen.

The scrim sits on the screen, outside the filtered layer: a gradient inside it
would be dragged through the same brightness correction - the same lesson the
launcher photo taught - and the text has to stay legible whatever the
photograph happens to be doing behind it.

## A picture per screen, and a live one in the hero

The launcher's background used to be the only one; every screen below it sat on
flat black, which reads like a file manager. Each of live, on-demand and room
service now takes its own still from the console (`scene.live`, `scene.vod`,
`scene.service`), falling back to the launcher's picture when unset.

**Stills only, and the console refuses a video by name.** These screens are one
press away from the player, and a background video there is a decoder the
player does not get. The launcher may spend one, because nothing else is
running while a guest is looking at it.

**The live hero plays the channel it is naming.** Muted, behind the text, under
the same gradient that keeps the channel name readable when a broadcast cuts to
white. Three things keep that safe on a box with one or two decoders:

- it starts **900ms late**, so passing through this screen never opens a stream;
- it is destroyed on `remove-hook`, which fires before the full player mounts -
  verified on the box as exactly one `Codec released` followed by one `create
  MediaCodec video decoder`, not two decoders alive at once;
- it **fails silently**. A channel that will not open here leaves the panel's
  own gradient and says nothing: the viewer has not asked for it yet, so a
  curtain and a retry button would be answering a question nobody put.

The hero previews the featured channel only. Following focus around the grid
would mean a stream per card the remote passes over, which is a request storm
aimed at the panel for a picture nobody is watching.

The room-service notice sits on the same treatment - the property's photograph
behind its own words, rather than a flat panel of colour that reads as a system
dialog.

## The promo loop on the home screen

The home background is the Siem Reap promo (`hotel_promo_siem_reap_10s.mp4`,
generated elsewhere), re-encoded before upload. The original was 12MB at
9.7 Mbps with an audio track and a full-range (`yuvj420p`) tag - all three
wrong for a background that loads on every boot and is always muted:

```bash
ffmpeg -i in.mp4 -an   -vf "scale=in_range=full:out_range=limited,format=yuv420p"   -c:v libx264 -preset slow -crf 24 -maxrate 3000k -bufsize 6000k   -profile:v high -level 4.0 -g 60   -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709   -movflags +faststart out.mp4
```

3.17MB, 2.5 Mbps, no audio, index at the front. The console's upload check
reported `faststart: true`, which is the point of that check existing.

The poster is a frame at t=0.8s rather than t=0: the clip fades up from black,
so frame 0 is a black JPEG. That matters twice over - the poster covers the
moment before the video decodes, *and* `sceneryUrl` falls back to it, so it is
also the still behind 影视点播 when no scene is set for that screen.

Verified on the 4K emulator: one decoder (`c2.goldfish.h264.decoder#944`), a
flush every ~301 frames, which is the loop restarting on schedule.

Two things worth knowing before swapping in another promo:

- **Burned-in captions collide with the tile bar.** This clip's own titles sit
  in the lower third, which is exactly where the launcher's row of tiles is.
  It reads fine, but a clip made for this screen should keep its bottom third
  clear.
- **It dips to black at the seam.** The clip fades out and back in, so the loop
  blinks dark once every 10 seconds. Symmetric, so it reads as a transition
  rather than a glitch - but a clip that starts and ends on the same bright
  frame loops invisibly.

## Rooms and devices - what "managing users" means here

There are no user accounts. A guest never signs in. The unit of management is
the **room**, and `/admin/` → 房间与设备 is where a building is run.

Three separate things decide what one television shows, and they are kept
separate on purpose:

| | what it decides | where |
| --- | --- | --- |
| 线路 (XUI account) | the **catalogue** - which channels and films exist at all | 房间与设备 → 线路 → 换 |
| 房间 | the **dressing** - welcome card, notices, which room an order came from | 房间与设备 → 房间号 / 住客 |
| 成人授权 | the restricted section, per box, off by default | 成人板块 → 按房间授权 |

Two floors on two different lines get two different channel lists. That is the
coarsest "who sees what" control there is, and it is a per-box field.

**Check-out revokes.** `POST /api/admin/rooms/:roomId/checkout` clears the
guest name *and* turns off the restricted section for every box in that room
(`rooms.js`, `checkOut`). A guest who was allowed it on Tuesday does not hand
that to whoever arrives on Wednesday, and nobody at a front desk has to
remember. This is the only reason `rooms.js` exists rather than a handful of
loose UPDATEs.

Other behaviour worth not re-deriving:

- **Room numbers are created by typing them.** Assigning a box to 301 creates
  room 301 if it does not exist. There is no separate "add room" form.
- **A line is username *and* password, or neither.** Half a credential is
  rejected with 400: it would leave a box that looks configured and plays
  nothing. Clearing both un-pairs the box and mints a fresh pairing code.
- **最后开机, not 在线.** `last_seen` is written by `/api/device/hello`, which
  the launcher calls once at startup and never again. A television that has
  been on all week reports the day it was switched on. There is no heartbeat.
- **移除 is for televisions that are gone.** A box still on the wall
  re-registers on its next boot as a new, unassigned device with a new code.
- **Rooms with no boxes** get their own strip under the table, because they
  have no row to live in and would otherwise be undeletable. Deleting one is
  refused (409) while any box still points at it.

Endpoints, all behind the console token:

```
GET    /api/admin/rooms                      # devices + rooms in one answer
POST   /api/admin/devices/:deviceId          # roomId / label / lineUser+linePass / adultAllowed
DELETE /api/admin/devices/:deviceId
POST   /api/admin/rooms                      # roomId + building / floor / guestName / checkedIn
DELETE /api/admin/rooms/:roomId              # 409 while a box is in it
POST   /api/admin/rooms/:roomId/checkin      # { guestName }
POST   /api/admin/rooms/:roomId/checkout     # clears the name, revokes entitlements
```

Every write answers with the whole roster, so the console rebuilds its table
from the server rather than from what the browser hoped happened.

### A curl footgun on this workstation

`curl -d '{"label":"测试机"}'` from Git Bash sends a Content-Length that does
not match the UTF-8 body, and fastify answers
`FST_ERR_CTP_INVALID_CONTENT_LENGTH`. Nothing is wrong with the server - a
browser sends it correctly. Test non-ASCII bodies with `python -c` and
`urllib`, not curl.

## 客户端安装包

**签名固定了，这一步不可逆，也不能再改。**

之前发出去的是 `app-debug.apk` —— 用 debug keystore 签的。对一次酒店部署来说
这是个陷阱：debug 签名的包**没法被 release 包覆盖升级**，每台电视都得先手工
卸载。实测确认：

```
INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.wewatch.tv
signatures do not match newer version
```

而且换签名还有第二个后果，更不明显：**Android 8 之后 ANDROID_ID 是按签名算的**，
所以换签名 = 每台盒子的 deviceId 全变，全部重新注册成新设备，房间、成人授权、
观看权一起丢。模拟器上验过：debug 版是 `d0999154cb31e427`，release 版变成
`f754d393f481499a`。

所以签名必须在铺货之前定下来，现在定了：

```
keystore : <keystore 目录>/release.jks      （不在项目目录里）
口令     : <keystore 目录>/keystore.properties
别名     : wewatch
SHA-256  : EA:61:40:E4:AA:F2:8C:D9:87:79:CA:82:15:6E:06:D7:C7:35:B1:F5:8B:3A:38:64:2A:35:A7:08:15:36:3E:27
有效期   : 30 年
```

**钥匙丢了就再也发不出能覆盖升级的包。** 它故意放在项目目录之外 —— 每次部署都
会把项目目录整个打包传到服务器，签名钥匙没有任何理由出现在那里面。

出包：

```bash
cd ott-frontend/shell
./gradlew assembleRelease -PportalUrl=https://ott.example.com/
# 产物 app/build/outputs/apk/release/app-release.apk
```

（`gradlew` 之前是缺的 —— wrapper 目录是空的，只能在 Android Studio 里点。
已经用 `gradle wrapper --gradle-version 8.11.1` 补回来了。）

### 下载地址

```
https://ott.example.com/apk        ← 短地址，电视上用遥控器敲得动
https://ott.example.com/download   ← 安装页：版本、大小、SHA-256、二维码、装机步骤
```

`/download` 上的版本号来自 `media/tv.apk.json` 这个随包写的小文件，**不是**
`APP_VERSION` —— 后者是 web bundle 的版本，两者各走各的（薄壳的意义就在于 UI
可以不换 APK 就更新）。传新包记得一起更新它：

```bash
scp app-release.apk root@<APP_HOST>:/opt/wewatch-ott/data/bff/media/tv-<版本>.apk
ssh ... "cd /opt/wewatch-ott/data/bff/media && cp tv-<版本>.apk tv.apk   && printf '{\"version\":\"<版本>\"}' > tv.apk.json"
```

## 备份

以前**一个备份都没有**。而且这件事有个陷阱：`ott.db` 本体只有 4 KB，服务启动
之后写的东西全在 `ott.db-wal` 里，谁要是只拷了 `.db` 就等于拿到一个空库，而且
要到恢复的时候才会发现。

`/opt/wewatch-ott/backup.sh` 用 `VACUUM INTO` 做快照 —— 它会开一个读事务、
把 WAL 折进去、写出一个自洽的单文件。每晚 3:17 跑（`/etc/cron.d/wewatch-backup`），
库留 14 天，媒体留 7 天，在 `/opt/wewatch-ott/backups/`。

装好当天验过恢复：解出来的库里 36 台设备、3 个房间、12 条设置、11 个菜品都在。
**备份没验过恢复就等于没有备份。**

## 收款：Jeepay

驱动是从 vps-resale-panel 搬过来的（那边真金白银跑过），移植成了无依赖的
`bff/src/jeepay.js`。三种钱走同一条管子，只是「付完之后做什么」不同：

| kind | 谁付 | 付完做什么 |
| --- | --- | --- |
| `service` | 客人 | 客房服务订单标成已付款 |
| `unlock` | 客人 | 这台盒子的观看权往后延 N 天 |
| `property` | 酒店 | 全楼服务费到期日往后延 N 天 |

配置在 `/admin/` → 收款与计费。**密钥存在 settings 表里，永远不回显** ——
后台开在公网域名上，一个从来不发出去的值没人能从屏幕上抄走；保存时留空 = 不改。

### 谁出钱：一个开关的两面

- **酒店付费**（默认）：酒店按期付服务费，房间全免费，电视上看不到任何收款入口。
- **客人付费**：住客自己按天买观看权。

服务费到期**不会黑屏**，只是从「免费」变成「客人自己买」—— 切到客人付费模式才
真的开始收。

**底线写在 `billing.js` 的 `gated()` 里：收不了款的时候什么都不锁。** 通道没配、
密钥填错、Jeepay 那台挂了 —— 这些时候照常上锁的结果是整栋楼打不开，而客人连付钱
的办法都没有。坏掉的收银台应该让东西免费，不是让东西消失。

直播**默认不在收费范围内**。一台打开只有黑屏的电视，客人只会以为是坏的。

### 两条铁律，代码是围着它们写的

1. **回调会丢。** 所以除了等回调，还每分钟主动查一轮（`pay.reconcile`）。
   过期的单还会继续查满 24 小时 —— 扫码付款经常是客人扫完去找手机银行，
   回来时我们这边 15 分钟已经到了。迟到的钱记账但不自动发货，在日志和订单上
   都吼一声，等人工处理。
2. **同一笔钱只能生效一次。** 判断依据只有一个：
   `UPDATE ... WHERE state != 'paid'` 改到了几行。
   **不要**在 `markPaid` 开头加 `if (row.state === 'paid') return`。
   看着更直白，但并发下拦不住（回调和对账同时到，两边各自读到 pending），
   而且会让「去掉 UPDATE 上的 WHERE」测不出来 —— 第一版就是这么写的，
   自检把防重复发货测成了绿的。

### 菜单币种必须和收款币种一致

真会收错钱：种子菜单是 `Nasi Goreng 35000 IDR`，通道配成 USD，下单时按
「价格 × 收款币种」算 —— 一盘炒饭 **35000 美元**。

没有汇率，也不该替酒店定汇率，所以对不上就**不走线上收款**，单子照常成立、
留给前台结算，后台菜单上方挂一条红色警告。见 `service.js` 的 `currencyCheck()`。

另外金额单位是**最小单位**，不是「分」：人民币和美元两位小数，
瑞尔和印尼盾没有小数位（`pay.js` 的 `MINOR`）。统一乘 100 的话柬埔寨每一笔
都会变成一百倍。

### 改动钱相关的代码之后

```bash
cd ott-frontend/bff && node scripts/selfcheck.js
```

86 项，不联网，网关那端用假 fetch 顶掉。它查的全是「不报错但钱算错了」那一类。
**自检本身也要验**：故意把签名过滤改成 `if (v)`、或者拿掉 `WHERE state != 'paid'`，
自检必须变红。测不出来的自检比没有更糟 —— 它会让你以为查过了。

想跑真链路，`scratchpad/fakepay.mjs` 是个假网关：收单、发码、`/__pay?orderNo=XX`
触发一次带正确签名的回调。

### PUBLIC_BASE_URL

`.env` 里必须有，而且必须是外面看到的那个 https 地址。它是回调地址的来源 ——
留 localhost 的话钱收了订单不变已支付。没配的时候 `createOrder` 直接拒绝下单，
宁可不收，也不能收了不发货。

注意 `req.protocol` 在这里**靠不住**：nginx 终止 TLS 之后走 docker 网桥进来，
请求看着就是 http。`trustProxy: 1`（跳数，不是地址 —— 容器看到的来源是
172.21.0.1 不是回环）修的是 `req.ip`，地址还是得从 `PUBLIC_BASE_URL` 来。

## 客房服务

之前这块只有一半：菜单是开机种进去的印尼宿舍菜、后台改不了；客人下的单进了
`orders` 表然后**没有任何地方能看到**。现在 `/admin/` → 客房服务里两样都有了，
订单带收款状态，前台一页就够。

菜品删掉不影响历史订单 —— `orders.items_json` 存的是当时的名字和价格快照。

## 多租户：一台服务器，很多家酒店

APK 里烧死的地址只有一个，十家酒店的盒子都打到同一台服务器 —— 所以
**「这台盒子是哪家的」必须由服务端认出来**，一店一套部署做不到这件事。
因此是一套部署、多租户。

改造之前每张表都是按一家店写的，十家接进来会这样（不是推测，是当时的
schema 决定的）：

| 现象 | 根因 |
| --- | --- |
| 十家电视显示同一个名字、同一张背景 | `settings.key` 是主键，全局只有一份 |
| 十家共用一份菜单一份价格 | `service_items` 没有归属字段 |
| A 店的 301 和 B 店的 301 是同一行 | `rooms.room_id` 是主键 |
| A 店退房清掉了 B 店客人的姓名和授权 | 同上 |
| 一家交服务费，十家一起免费 | `billing.paidUntil` 是一个全局值 |
| 十家的餐费全进同一个商户 | 收款通道只有一套 |
| 后台口令给了 A 店 = 给了所有店 | 只有一个 ADMIN_TOKEN |

### 现在的结构

```
properties（酒店）
 ├─ 品牌   名字 / logo / 各页面背景      → settings，按 property_id 分
 ├─ 线路   XUI 账号，决定片库            → properties 表上，留空 = 平台默认
 ├─ 菜单   菜品 / 价格 / 币种            → service_items.property_id
 ├─ 计费   谁出钱 / 到期日 / 档位        → settings
 ├─ 收款   点餐进它自己的商户            → settings，scope = property_id
 └─ 账号   前台自己的后台口令            → properties.token_hash（scrypt）
      └─ rooms（房间号在这家店内唯一）
           └─ devices
```

`property_id = 0` 是平台自己的命名空间：后台总口令、我们自己的收款商户、
新盒子默认归属。1 以上是各家酒店。

### 钱的归属：内容归平台，餐食归酒店

```js
scopeOf(kind, propertyId) => kind === 'service' ? propertyId : PLATFORM
```

- `service`（客人点餐）→ **这家酒店自己的 Jeepay 商户**。餐是酒店做的，
  钱直接进酒店账上，我们不经手 —— 不用对账分账，也不碰别人的资金。
- `unlock`（客人买观看权）→ 平台商户。片库是我们供的。
- `property`（酒店交服务费）→ 平台商户。

所以**收款通道有两套**，后台的「收款与计费」上下分开。传错一个 scope
就是把 A 店的餐费打进 B 店的账户，这也是为什么 `pay.js` 里每个函数都
要求显式给出 scope，一个默认值都没有。

### 盒子怎么归属到酒店

三条线索，依次试（`devices.js` 的 `adopt`）：

1. **同一个 MAC 以前配过** —— 换过固件、恢复过出厂的老盒子按原样接回去。
2. **平台设了「新盒子默认进哪家」** —— 一次铺一家时设上，整批插电即用，
   现场一个字都不用输。**铺完一定要清掉**，否则下一家的盒子会进错门。
3. **都没有** —— 停在配对码那一页，等人在后台把它划给某一家。
   十家同时在跑时这是唯一安全的默认。

线路也跟着酒店走，不再跟着盒子走：每次开机按所属酒店取一次，
给某家换片库是改一行，不是改三百台。

### 两层登录

- **平台**（`ADMIN_TOKEN`）：十家都看得见，能建店删店划盒子、改平台商户。
  **这个口令从来不发给酒店。**
- **酒店**（`properties.token_hash`）：只看得见自己这一家。前台会把它写在
  便签上贴在电脑边，那没关系 —— 它只能打开一家。

真正挡住 A 店看 B 店的是**服务端每条查询里的 WHERE property_id**，
不是界面上藏了几个按钮。

### 一条护栏：漏带酒店 id 会当场炸

`getSetting` / `setSetting` 的第一个参数是酒店 id，**没有默认值，类型不对
直接抛**。十家共用一张 settings 表，漏带 id 的后果是读到别家的配置：
A 店的电视显示 B 店的名字、B 店的 PIN 开了 A 店的门。这种错误不报错、
不崩溃，只会安静地串台 —— 所以宁可让它在第一次调用时就炸掉。

（改完那天这条护栏立刻就抓到了一个：旧的支付自检漏带 id，一跑就炸。）

### 迁移

对已经在跑的库是安全的、可重复执行的。第一次跑把现有的一切归到 1 号酒店
（名字取自原来的 `home.propertyName`），之后再跑什么都不做。
`rooms` 和 `settings` 换主键要重建表 —— SQLite 的 ALTER TABLE 改不了主键。

**上线前一定要拿生产库的备份跑一遍**：

```bash
scp root@<APP_HOST>:/opt/wewatch-ott/backups/ott-<日期>.db.gz .
gunzip ott-<日期>.db.gz
DB_FILE=./ott-<日期>.db MEDIA_DIR=/tmp/m node -e "import('./src/db.js')" --input-type=module
```

我这么做了，也因此在上线前就发现 media 的归属列漏在回填名单外（升级后
酒店会看不见自己已上传的 5 个文件）。

### 上线那次真炸了一回

`pay.js` 里 `CREATE INDEX ... ON pay_orders(property_id, ...)` 写在了
`ALTER TABLE ADD COLUMN property_id` **前面**。老库里 `CREATE TABLE IF NOT
EXISTS` 什么都不做，于是索引找不到列，整个 `db.exec` 抛
`no such column: property_id`，容器起不来、崩溃重启。

本地测不出来是因为本地库是新建的，建表语句里就带着那一列。
**加列 + 加索引必须成对，且索引在后。**

### 两份自检

```bash
cd ott-frontend/bff
node scripts/selfcheck.js       # 88 项：钱算得对不对
node scripts/tenancy-check.js   # 78 项：A 店看不看得见 B 店
```

`tenancy-check` 建两家酒店、各放一台盒子、房间都叫 301，然后逐条撞：
退房、改菜品、发观看权、删房间、交服务费、登录。这些线上不会报错 ——
只会是 B 店的客人发现自己的姓名变成了别人的。

## 示例数据已经拿掉了

`seedIfEmpty()` 以前会在首次启动时种 3 个印尼房间、11 个印尼菜品和一条印尼欢迎语。
单店时代这是方便，多租户之后是害处：

1. 新开一家酒店应该是一张白纸，前台第一次登录不该看到一份炒饭菜单和三个假住客。
2. **它会把清理做的功白做** —— 房间表一空就重新种回去。
3. 那些 INSERT 是单店时代写的，不带 `property_id`，种出来是一批谁也看不见的孤儿行。

现在它只剩一件事：给升级上来的老库补柬埔寨语菜名（那是迁移，不是示例）。

## 后台的两个坑，已修

**改酒店名字要改两个地方** —— 「酒店」栏的名字是后台列表里的标签，
「文字」栏的名字才是电视上显示的。谁都不会想到改一个还要去另一个地方再改一次，
结果是后台写着新名字、客房电视上还挂着旧的。现在改名字会一起改电视上那个；
想让两者不同，改完再去「文字」单独调。

**平台收款商户在界面上没有入口** —— 接口一直都有，表单漏了，
于是「客人买观看权、酒店交服务费」这两笔钱的商户只能用 curl 配。
现在「收款与计费」上方有个开关，两套通道各填各的：

```
这家酒店（客人点餐）   → 每家各填各的，钱进酒店账上
平台（观看权 + 服务费） → 十家共用一套，只有平台管理员能改
```

## 运营速查

后台地址、两层登录、「想改某样东西去哪一栏」整理成了一页给运营看的东西，
artifact（私有）：`WeWatch 后台速查`。三个后台入口是：

```
https://ott.example.com/admin/        日常全在这里（酒店也用）
http://<PANEL_HOST><PANEL_PATH>             XUI 面板，频道源和线路（只有平台）
https://ott.example.com/collector/    采集器，往面板灌片库（只有平台）
https://ott.example.com/download      装机页（短地址 /apk）
```

## 开机自启（1.2.0 起）

酒店里没人会先拿遥控器找图标。两条路都留着，因为**第一条在新固件上会被静默拦掉**：

**1. 开机广播**（`BootReceiver.kt`）——收 `BOOT_COMPLETED` / `QUICKBOOT_POWERON`
（国产盒子的快速启动发的是后者，收不到标准那条）后拉起 MainActivity。

**2. 当桌面**（清单里的 `CATEGORY_HOME`）——装机时设成默认桌面。

模拟器上实测（Android 15 / API 35）：

| | 结果 |
| --- | --- |
| 只靠开机广播 | 接收器**触发了**、进程起来了、日志有 `boot autostart: launched`，**但前台仍是系统桌面** |
| 设成默认桌面 + 停掉竞争桌面 | 重启后不碰遥控器，**直接进我们的界面** ✅ |

第一条失败的样子值得记住：**`startActivity` 不抛异常，只是没生效** ——
Android 10+ 限制后台启动 Activity。装机的人不会发现，直到第二天客人说电视打不开。
`BootReceiver` 里那条 warn 日志是唯一线索。

竞争桌面这件事：Google TV Launcher 的 HOME 过滤器带 `priority=2`，
第三方应用给不了这个优先级，所以光设默认不够。实测下来解析顺序是它赢。

**装机步骤（有竞争桌面的盒子）**：

```bash
adb shell cmd package set-home-activity com.wewatch.tv/.MainActivity
adb shell pm disable-user --user 0 <竞争桌面的包名>   # 例如 com.google.android.tvlauncher
adb reboot   # 验一次：不碰遥控器，看是不是直接进来
```

国产 AOSP 盒子多半没有竞争桌面，设个默认就行。

### 配套：开机时网络还没通

电视通电后我们比 Wi-Fi 关联/DHCP 更早跑起来，第一次 hello 几乎必然失败。
原来会立刻把「连接失败 / 重试」甩给刚进门的客人。现在退避重试约一分钟
（1→2→4→8→15→15→15 秒），期间屏幕上还是转圈，看起来就是「电视在开机」。
一分钟还不通才摆错误出来。

## 直播三档 + 排查叠层

参考 NativeWasmTv 的做法加的两样。

**三档直播模式**（`hls.ts` 的 `LIVE_PROFILES`）——缓冲越长越不卡、也越落后：

| | maxBuffer | liveSyncDurationCount |
| --- | --- | --- |
| stable 流畅优先 | 30s | 6 |
| balanced 标准（默认） | 12s | 3 |
| low 低延迟 | 6s | 2 |

后台定默认值，播放器底部有个按钮循环切、按完重调当前频道。
**盒子自己改过的以自己的为准** —— 电视前面的人比后台更知道它此刻卡不卡。

**排查叠层**——后台按酒店整店开关（上门前开、走之前关），显示分辨率、码率、
带宽、缓冲、丢帧、直连还是走中继、当前档位。带键盘时按 `i` 也能开。

它要回答的是一个在现场分不清的问题：这个台卡，是**上行不够**（带宽低、缓冲见底）、
**盒子解不动**（丢帧率高）、还是**源本身坏**（一直在重连）？三种的处理完全不同。
模拟器上实测丢帧 34.5% —— 正是「解不动」的样子。

两个显示上的坑，都修了：

- `level?.width ?? video.videoWidth` **是错的**，要用 `||`。很多单档直播的 m3u8
  不写 RESOLUTION，`level.width` 就是 `0`，而 `??` 只在 null/undefined 时回退，
  0 被当成有效值原样带出去 —— 画面好好放着，叠层显示 `0×0`。
- 取不到的值**不要显示成 0**。playlist 没写 BANDWIDTH 就别印「0 kbps」，
  那会让人以为叠层坏了，而不是流里本来就没有。

## 点播搜索

**片库 868 部，852 部是纯中文片名，而客人手里只有一个遥控器。**
这两件事决定了搜索只能按**拼音首字母**做：打 `sywj` 找《深渊无间》。
一个只能打英文的搜索框，对这个片库等于完全没用 —— 片名里的字客人一个都打不出来。

### 首字母怎么来的：零依赖

没引拼音库。用 Node 自带的 ICU：`Intl.Collator('zh-Hans-u-co-pinyin')` 会按拼音
给汉字排序，于是「这个字声母是什么」就变成「它落在哪两个边界字之间」——
一次二分，23 次比较（`bff/src/pinyin.js`）。

**边界字必须是每个声母的第一个音节**，不是随便挑一个同声母的字：
s 那格要用「仨」(sa) 而不是「四」(si)，否则 shen < si，「深」被归到 r。
这个错我犯过，14 个样本里错 1 个。

容器里是完整 ICU 78.2，确认可用。868 条算完 **2ms**，结果随片库一起下发到电视，
电视端搜索是纯内存过滤，按一个字母出一次结果，没有任何请求。

### 排序：开头的优先

只用「包含」的话，打一个 `Z` 命中 **329 部**（片名里任何一个字是 z 声母都算），
等于没筛。而人打第一个字母时想的是「这片名是 Z 开头的」。所以分三档：

| | |
| --- | --- |
| 3 分 | 首字母串或片名**以查询开头** |
| 2 分 | 包含 |
| 1 分 | 年份匹配（「2026」＝今年的片） |

中间匹配留着但排后面：《坠落2：死点》的 `zl2sd`，有人会打 `sd`，该找得到，
只是不该排在 Z 开头那一百部前面。超过 60 条只画 60 张，计数里说清楚还有多少。

## D-pad 导航修了两处（影响所有界面）

加搜索入口时发现的，但两处都是导航本身的老毛病。

**① 同一行的候选没有被优先。** 原来是 `score = along + across*3`。标题栏最左是
返回键、最右是搜索，隔着 1560px；而正下方的海报只隔几十像素 —— 按右键时海报
分数更低，焦点一头扎进内容区，**标题栏右边那几个按钮按右键永远够不到**。

改成硬档位：有垂直重叠的先比，没重叠的只有在同一条线上什么都没有时才考虑。
这也是 Android 自己的空间导航采用的规则。

**② 重叠加分没有上限。** 于是一个很宽的按钮能靠重叠量赢过正下方的窄按钮：
搜索页从 `W` 按下会**跳过整个数字行**落到「删除」。把加分封顶在来源元素自身的
宽/高上 —— 重叠最多只能「完全盖住来源」，再宽也不多给分。

改完实测：返回 → 右 → 搜索 → 右 → 中文；字母列 A→H→O→V→**1**→删除。

## 播放器按钮看不见（已修）

用户报的：直播时底部按钮没选中就看不见。查下来是两层：

1. `.btn.ghost` 的边框用的是 `--line`（8% 白）—— 那个值是给「两块深色面板之间的
   分隔线」定的，压在任何有内容的背景上等于没有。**按钮不是分隔线**：
   它要让人在没选中的时候就看得出是个按钮。
2. 更要命的是焦点态：`.btn:focus` 是白底黑字，而在盒子上**字色立刻翻黑、背景要
   晚一两帧才重绘完** —— 中间那几帧是黑字压黑底。按着方向键连续移动时，
   这几帧就是你一直看到的样子。

播放器里改成 **换底色不换字色**（焦点 = 主色底 + 白字），任何一帧都是白字压深色。
同时去掉了播放器里的 `backdrop-filter` —— 它在机顶盒 WebView 上会强制新建合成层，
加剧上面那个重绘延迟，而纯黑底完全够用。

## 原生播放内核：量过之后的结论

2026-09-15。问题是「WebView + hls.js 换成原生播放器值不值」，答案不能靠推理，
所以做了一个单独的测量 APK（`shell/probe/`，不参与出包），
把 91 个直播台在同一台机器、同一条线路上分别跑了 Media3、IJKPlayer、hls.js。
完整结果在 [`shell/probe/RESULTS.md`](../shell/probe/RESULTS.md)。

拿得准的三条：

1. **通过率上三个引擎基本打平**（87 个活源：原生 84，hls.js 82）。
   原生并没有像预期那样「多放出一堆台」。
2. **真正的差别是那几个浏览器取不到的台。** 76 Phoenix Infonews、91 CCTV5
   整台，5 ATV3 半通 —— 播放列表和分片都没有 CORS 头，浏览器永远拿不到，
   今天全靠 `relay.js` 绕服务器。**这几个台的流量压在我们自己的 VPS 上**，
   而 CCTV5 是酒店里同时看的人最多的台。换原生内核唯一算得出账的收益是这个。
3. **91 个台里有 8 个是源本身的问题**（4 个 404、1 个分片服务器连不上、
   2 个源不稳、1 个半死）。修这 8 个比换内核划算。

换内核如果真要做，有两脚不踩上去就会白丢台，而且都很难查：

- **UA 必须像浏览器。** ATV3 的上游对 `ExoPlayerLib/1.5.1` 和任何自定义 UA
  一律 403，换 WebView 的 UA 就通。
- **必须允许 https→http 降级跳转**（`setAllowCrossProtocolRedirects(true)`）。
  面板给的是 https 地址，302 到只有明文 http 的 CDN；不开这个每一个台都失败。

起播时间上原生确实快（中位 1.9s vs 5.4s），但**这个数字是模拟器上的，
只能信方向不能信数值** —— 模拟器用的是 `c2.goldfish.h264.decoder`，
不是真盒子的硬解。真要拿它做决定，得插网线在真盒子上重跑一遍，
工装已经做成可以带到现场跑的样子。

一个测量上的坑记在这里：三个引擎放同一个进程里连着跑，第二轮开始 Media3 对
**每一个台**都报 `ERROR_CODE_DECODER_INIT_FAILED` —— 解码器实例被前面的引擎占光了。
这种失败长得特别像「这个内核不行」，实际是工装自己造出来的。一个引擎一个进程。

## 两套电视模板

2026-09-16。同一个 APP、同一套后台，电视上的界面有两套，**按酒店选**
（后台「电视端 → 界面模板」，改完盒子下次开机生效）：

| 模板 | 开机看到的 | 适合 |
| --- | --- | --- |
| `portal` 酒店门户（默认） | 宫格首页，直播是其中一格 | 度假酒店 —— 客人会去翻点播和点餐 |
| `live` 直播优先 | 正在播的那个台，全屏 | 商务酒店、长住公寓 —— 进门就是开电视 |

两套没有优劣，只有场合。默认 `portal`，**已经在用的酒店不会因为多了一套模板
就变样**。设置存在 `settings` 表的 `ui.template`，按 property 分开，
`tenancy-check.js` 里有一节专门撞它（给 A 店换模板不能把 B 店的首页弄没）。

### 直播优先模板的几个决定

- **开机落在上次看的台上**，没有记录才落到频道号最小的。存在盒子本地
  （`localStorage`），不是服务器 —— 这是「这台电视」的状态不是「这个房间」的，
  而且开机路径上每多一次网络请求都是客人在等。
- **菜单浮在正在播的画面上，底下的台不停。** 在电视上画面一黑就等于"卡住了"，
  而客人只是想看看有什么别的可看。
- **一个台都没有的时候退回门户。** 线路没配好或者频道全被限制掉的时候，
  直播优先就是一块黑屏加一句"没有频道"，客人没有出路；门户至少还有客房服务。
  模板不该把人锁在空房间里。
- **播放器是同一个，只换皮肤**（`data-skin`）。两套模板各写一遍播放器的话，
  下次修切台的 bug 要修两遍，而第二遍一定会被忘掉。唯一的行为差别是左下角
  那个键：模板 A 是「返回」（回上一屏），模板 B 是「菜单」（B 没有上一屏）。

### 顺手修掉的两个老毛病

这两个在模板 A 下看不出来，因为模板 A 的首页返回键本来就什么都不做：

- **浮层关掉之后要把返回键还回去**，不能设成「什么都不做」（`nav.ts` 的
  `grabBack`）。语言选择原来就是后者，在模板 B 下关掉它，播放器的返回键
  （退数字输入、关频道列表）会全部失灵 —— 在电视上等于只能拔电源。
- **有浮层盖着的时候，播放器不抢遥控器**。播放器的按键处理挂在 document 上
  而且是捕获阶段，不让它先退出来的话，客人在菜单里按上下是在换台。
  认的是 `data-modal` 属性，以后加别的浮层加个属性就行。

## 产品改名 KDTV（2026-09-16）

客人和运营看得见的地方全部改成 **KDTV**：电视上的应用名、开机画面、
后台标题、安装页、默认酒店名。APK 重出到 **1.2.1（versionCode 4）**。

**三个名字故意没有跟着改**，改了会出大事：

| 没改的 | 为什么 |
| --- | --- |
| 包名 | 「这台盒子上的这个应用」的身份。改了对已装机的电视来说是**另一个应用**：装不上去，只能先手动卸载。 |
| JS 桥名 | 是 APK 注入、网页读取的，**两边不会同时更新**。单方面改一边，设备号就拿不到，每个内容请求都会 403。 |
| 签名证书 | 证书换了就是另一把钥匙，装过的机器一台也升不上去。 |

一句话：**外面看到的名字可以随时改，身份不能改。**

### 后来真把它改了（2026-09-16，趁还没有酒店上线）

包名 `com.wewatch.tv` → **`com.kdtv.tv`**，桥名 `WeWatchShell` → **`KDTVShell`**，
APK 出到 **1.3.0 / versionCode 5**。签名钥匙**没换** —— 证书主题里那个旧名字是
历史，客人看不见，换钥匙反而会让装过的机器升不上去。

实测澄清了一件我原先写错的事：**ANDROID_ID 不会因为改包名而变**，它跟着签名
钥匙走。改完之后盒子报上来的还是原来那个设备号，服务端认得它，不用重新配对。

**真正会断的是桥名。** 新 APK 注入 `KDTVShell`，而线上还是只认 `WeWatchShell`
的旧网页 —— 结果盒子退回了"网页自己生成的设备号"，界面上出现配对码，
看起来像一台全新的设备。所以 `web/src/api.ts` 里**两个名字都认**，
等所有盒子都换成新包之后才能把旧的删掉。在那之前删，就是给自己制造一批
打不开的电视。

## 中继发的 UA 把一个台挡在门外（2026-09-16 修）

`relay.js` 向上游取流时发的是 `User-Agent: WeWatchTV/1.0`，当初的理由只是
「有些 CDN 不接受没有 UA 的请求」。但实测发现有的上游不是要求「有 UA」，
而是**只认浏览器的 UA**：

```
5 ATV3   WeWatchTV/1.0 → 403     浏览器 UA → 200
```

而 ATV3 恰恰是**播放列表和分片都没有 CORS 头、浏览器只能走中继**的那几个台之一。
两件事凑在一起的结果是：**ATV3 在每一台盒子上都放不出来**，屏幕上只有
「信号中断，正在重连」，而没人会想到是我们自己发的 UA 被上游拒了。

改成发一个真实的安卓 WebView UA（盒子本来就是用 WebView 在放，中继只是替它
转一道，不该看起来像另一种客户端）。修完在模拟器上确认 ATV3 出画面。

这个问题是做播放引擎实测时顺出来的：量原生播放器要统一 UA，才发现 UA 本身
是个会拦人的东西，回头一查自己的中继正好踩着。

## 前台手机页 `/desk/`

```
https://ott.example.com/desk/
```

**和后台同一套接口、同一套登录，只是身体不同。** 后台是坐着用的：宽表格、
十几列、什么都能改。这个是**站在柜台前单手用的**，所以只剩两件事：

- **房间** —— 开房、退房、房态一眼扫完，看得到每间房的电视最后什么时候开过机
- **订单** —— 待处理排前面，接单 / 完成 / 取消，付没付一眼看得见

登录用的就是**那家酒店的后台口令**（平台总口令也能登，会先让你选哪一家）。
加到手机主屏就跟一个 App 一样。

几个只有在手机上才成立的决定：

- **输入框字号锁 16px。** 小于这个数 iOS 会在聚焦时自动放大整页，
  而且放大之后缩不回去 —— 前台会以为页面坏了。
- **按钮最小高 44px。** 这是拇指能可靠点中的下限，比好看重要。
- **退房和取消订单都要再问一遍**，接单和完成不用。区别在于能不能回头：
  往前走的动作点错了再点一次就回来，退房和取消订单没有撤销，
  而它们就挨着别的键摆着，站着用拇指点差不了几毫米。
- **轮询到的数据没变就不重画。** 每 20 秒无条件重画会把整片 DOM 换掉，
  前台的拇指正伸向「接单」时按钮被换成新的一个 —— 轻则没反应，
  重则列表顺序变了点到另一桌的单。这个是实测时撞出来的。
- **写「最后开机」不写「在线」。** `last_seen` 是盒子开机时说的那一次 hello，
  不是心跳。一台开了一周的电视会诚实地报出一周前那个时间，
  把它显示成「离线」，前台就会跑去查一个不存在的故障。
- **连不上服务器要明说**，并且告诉前台别照着屏幕上这份旧房态开房。
  安静地显示过期数据，比报错危险得多。
