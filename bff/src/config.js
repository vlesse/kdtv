// All runtime knobs in one place. Everything has a working default so the
// service boots with no env file at all.
export const config = {
  port: Number(process.env.PORT ?? 9081),
  host: process.env.HOST ?? '0.0.0.0',

  // Upstream XUI.one panel.
  xui: {
    base: process.env.XUI_BASE ?? 'http://xui-ott:80',
    // What the SET-TOP BOX should use to pull video. The box cannot reach
    // docker-internal names, so this is the operator-facing address/domain.
    publicBase: process.env.XUI_PUBLIC_BASE ?? 'http://localhost:9080',
    // Cache TTL for channel/category listings (ms). Protects XUI from
    // hundreds of boxes all refreshing at once.
    listTtlMs: Number(process.env.XUI_LIST_TTL_MS ?? 60_000),
    epgTtlMs: Number(process.env.XUI_EPG_TTL_MS ?? 120_000),
  },

  // Default line handed to a freshly activated device when no explicit
  // line is bound to it. Lets a box work the moment it is plugged in.
  defaultLine: {
    username: process.env.DEFAULT_LINE_USER ?? '',
    password: process.env.DEFAULT_LINE_PASS ?? '',
  },

  dbFile: process.env.DB_FILE ?? './data/ott.db',

  // Uploaded backgrounds and posters. Defaults beside the database so the
  // same volume carries both; a container sets it explicitly.
  mediaDir: process.env.MEDIA_DIR ?? './data/media',

  previews: {
    // 频道预览图多久重抓一次。直播画面十分钟前和现在差不多，
    // 而每抓一次就是一条到上游的连接。
    ttlMs: Number(process.env.PREVIEW_TTL_MS ?? 10 * 60_000),
  },

  admin: {
    // Console password. Left unset, one is generated on first boot and
    // written to the log - the console is never open to the internet
    // unauthenticated, but it is also never dead on arrival.
    token: process.env.ADMIN_TOKEN ?? '',
    // Largest single upload. A minute of 1080p loop is comfortably inside
    // this; anything much bigger has no business on a set-top box anyway.
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 200 * 1024 * 1024),
  },

  // Where the built TV app lives. Defaults to the sibling `web/dist` of a
  // source checkout; a container image sets it explicitly.
  webDist: process.env.WEB_DIST ?? '',

  // Web bundle version served to boxes for over-the-air update.
  appVersion: process.env.APP_VERSION ?? '1.0.0',

  /**
   * This service's own address, as the outside world reaches it.
   *
   * Needed wherever we have to *write down* a URL rather than answer one:
   * the installer page, and any callback address handed to a third party.
   * It cannot be derived reliably from the request - nginx terminates TLS and
   * proxies in over the docker bridge, so the request arrives looking like
   * plain http - and a guessed address is the kind of mistake that is invisible
   * until a payment gateway cannot call back.
   *
   * No default on purpose: the installer page falls back to the request's own
   * host, which is right for a source checkout and wrong in production, so
   * production sets it.
   */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, ''),

  // Home screen dressing defaults. These are the fallback: whatever the
  // admin console has stored in `settings` wins over them at request time.
  home: {
    backgroundUrl: process.env.HOME_BACKGROUND_URL ?? '',
    propertyName: process.env.PROPERTY_NAME ?? 'KDTV',
    supportContact: process.env.SUPPORT_CONTACT ?? '',
  },

  // Open-Meteo needs no key. Defaults to the Morowali industrial park.
  weather: {
    lat: Number(process.env.WEATHER_LAT ?? -2.83),
    lon: Number(process.env.WEATHER_LON ?? 122.14),
    ttlMs: Number(process.env.WEATHER_TTL_MS ?? 30 * 60_000),
  },
};
