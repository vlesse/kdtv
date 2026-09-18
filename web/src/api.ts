/**
 * BFF client.
 *
 * The box never learns a panel address: the only URL it knows is this
 * service's, baked into the shell at build time. Everything else - the line,
 * the room, the stream URLs - comes back from /api/device/hello.
 */

const BASE = import.meta.env.VITE_API_BASE ?? '';

export interface Channel {
  id: number;
  num: number;
  name: string;
  icon: string | null;
  /** 这一台此刻大概在放什么：一张服务端截的静图。没截到就是 null。 */
  poster?: string | null;
  categoryId: string;
  categoryName: string;
  hasArchive: boolean;
  /** Only ever true on a box that has unlocked the restricted section. */
  adult?: boolean;
}

export interface Category {
  id: string;
  name: string;
  count: number;
  adult?: boolean;
}

export interface EpgEntry {
  title: string;
  description: string;
  start: number | null;
  stop: number | null;
}

export interface MenuItem {
  id: number;
  name: { en: string; zh: string | null; id: string | null };
  price: number;
  currency: string;
  image: string | null;
}

export interface PaymentOrder {
  orderNo: string;
  kind: 'service' | 'unlock' | 'property';
  state: 'pending' | 'paid' | 'expired' | 'failed';
  amount: number;
  amountText: string;
  currency: string;
  subject: string;
  /** The QR is drawn on the server: see bff/src/pay.js. */
  qrSvg: string | null;
  codeUrl: string | null;
  payUrl: string | null;
  expiresAt: number;
  paidAt: number | null;
}

export interface BillingStatus {
  /** Sections this box has to pay for. Empty on a property that pays its own bill. */
  locked: ('live' | 'vod' | 'adult')[];
  passUntil: number | null;
  plans: { days: number; price: number; priceText: string }[];
  currency: string;
}

export interface VodItem {
  id: number;
  kind: 'movie' | 'series';
  name: string;
  icon: string | null;
  year: string | null;
  rating: number;
  categoryId: string;
  categoryName: string;
  container: string | null;
  adult?: boolean;
  /** 片名的拼音首字母，服务端算好的。遥控器上唯一能打出来的检索键。 */
  py?: string;
}

export interface Episode {
  id: number;
  season: number;
  num: number;
  title: string;
  container: string;
}

export interface VodDetail {
  kind: 'movie' | 'series';
  id: number;
  name: string;
  plot: string;
  cast: string;
  director: string;
  genre: string;
  year: string;
  released: string;
  rating: number;
  cover: string | null;
  duration?: string;
  container?: string;
  episodes?: Episode[];
}

export interface Weather {
  temp: number;
  icon: string;
  key: string;
  unavailable?: boolean;
}

export interface HomeBackground {
  type: 'image' | 'video' | 'none';
  url: string | null;
  poster: string | null;
}

export interface Branding {
  /** Boot screen photo. Cached locally so the next launch paints it instantly. */
  splashUrl: string | null;
  /** Shown behind the player while a stream is still being fetched. */
  loadingUrl: string | null;
  logoUrl: string | null;
  accent: string | null;
  customCss: string;
}

/** 电视界面模板：酒店门户 / 直播优先。由后台按酒店选。 */
export type TvTemplate = 'portal' | 'live';

export interface HomeConfig {
  propertyName: string;
  /** Legacy field, kept so an older bundle on a box still finds its photo. */
  backgroundUrl: string | null;
  background: HomeBackground;
  /** A still per screen, falling back to the launcher's own picture. */
  scenes?: { live: string | null; vod: string | null; service: string | null };
  /** 电视端行为开关：排查叠层、直播模式默认值。 */
  tv?: {
    diagnostics: boolean;
    liveProfile: 'stable' | 'balanced' | 'low';
    /** 这家酒店用哪一套电视界面。见 template.ts。 */
    template?: TvTemplate;
  };
  branding: Branding;
  supportContact: string | null;
  welcomeText: string | null;
  version: string;
}

export interface Session {
  activated: boolean;
  pairingCode: string | null;
  deviceId: string;
  room: { id: string; guestName: string | null; building: string | null } | null;
  profile: { status: string; expiresAt: string | null; maxConnections: string | null } | null;
  appVersion: string;
  /** Whether this room may show the restricted section at all. */
  adultAvailable?: boolean;
}

/**
 * The native shell's bridge, registered before the page's scripts run.
 *
 * This has to be readable synchronously at boot. An earlier version had the
 * shell push globals in onPageFinished, which lands *after* the app has
 * already introduced itself - so it registered under the browser fallback id,
 * then started sending the Android one, and every content call came back 403.
 */
interface ShellBridge {
  deviceId(): string;
  mac(): string;
  shellVersion?(): string;
}

/**
 * 盒子注入进来的身份桥。
 *
 * **两个名字都认，旧的那个是过渡用的。**
 *
 * 2026-09-16 产品改名 KDTV，桥名从 `WeWatchShell` 改成了 `KDTVShell`。
 * 但网页是服务端下发的、APK 是装在盒子上的，两者**不会同时更新** ——
 * 手里还装着旧包的测试机一拿到新网页，如果这里只认新名字，
 * `shell()` 就返回 null，设备号拿不到，每一个内容请求都会 403，
 * 而屏幕上只会显示「连接失败」，看不出是改名引起的。
 *
 * 所以先两个都认。等所有盒子都换成新包之后，可以把 `WeWatchShell` 删掉 ——
 * 在那之前删，就是给自己制造一批打不开的电视。
 */
function shell(): ShellBridge | null {
  const w = window as any;
  const b = w.KDTVShell ?? w.WeWatchShell;
  return b && typeof b.deviceId === 'function' ? (b as ShellBridge) : null;
}

/**
 * Can this client follow a redirect from HTTPS to plain HTTP?
 *
 * The boxes can - their WebView is built with mixed content allowed, because
 * the live CDNs speak only HTTP - and taking the redirect keeps their video
 * off our host entirely. A browser cannot, and silently shows a dead channel
 * instead, so it asks for a relayed URL and pays the extra hop.
 *
 * Keyed on the shell bridge rather than on the user agent: the bridge is a
 * fact about what is running the page, while a user agent is a guess.
 *
 * This is only the answer a client starts with. A box that can follow the
 * redirect can still meet a CDN that sends no CORS header, which no page can
 * read; both players ask for a relay a second time when that happens.
 */
export function needsRelay(): boolean {
  return shell() === null;
}

/** A stable per-box identity: shell bridge, then injected global, then browser. */
export function deviceId(): string {
  try {
    const fromShell = shell()?.deviceId();
    if (fromShell) return fromShell;
  } catch {
    /* bridge present but unhappy - fall through */
  }

  const injected = (window as any).__DEVICE_ID__;
  if (typeof injected === 'string' && injected) return injected;

  const KEY = 'ott.deviceId';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = 'web-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return 'web-ephemeral';
  }
}

function deviceMac(): string | undefined {
  try {
    const fromShell = shell()?.mac();
    if (fromShell) return fromShell;
  } catch {
    /* see deviceId */
  }
  const mac = (window as any).__DEVICE_MAC__;
  return typeof mac === 'string' && mac ? mac : undefined;
}

export function shellVersion(): string | null {
  try {
    return shell()?.shellVersion?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * The restricted section's unlock, held in memory and nowhere else.
 *
 * Not localStorage, deliberately. A guest checks out, the next one turns the
 * television on, and the app reloads - and an unlock that survived that would
 * be a section left standing open in a room nobody has vetted. Reloading the
 * page is the cheapest, most reliable lock there is, so it is the one used.
 */
let adultToken: string | null = null;

export function adultUnlocked(): boolean {
  return adultToken !== null;
}

async function send(path: string, init: RequestInit): Promise<Response> {
  return fetch(BASE + path, {
    ...init,
    headers: {
      'X-Device-Id': deviceId(),
      ...(adultToken ? { 'X-Adult-Token': adultToken } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
}

/** Guards the self-heal below against looping if the handshake keeps failing. */
let healing: Promise<unknown> | null = null;

async function req<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  let res = await send(path, init);

  // The box is known to the server under some id; if it ever asks with a
  // different one - a shell upgrade, cleared storage, a bridge that appeared
  // late - re-introduce it once rather than showing an empty screen.
  if (res.status === 403 && retry && path !== '/api/device/hello') {
    healing ??= req('/api/device/hello', {
      method: 'POST',
      body: JSON.stringify({ deviceId: deviceId(), mac: deviceMac() }),
    }, false).catch(() => null);
    await healing;
    healing = null;
    res = await send(path, init);
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error ?? '';
    } catch {
      /* body was not json */
    }
    // The status rides along: a 402 means "this costs money", which the caller
    // answers with a price list, not with the red failure curtain it shows for
    // everything else.
    throw Object.assign(new Error(detail || `${res.status} ${res.statusText}`), {
      status: res.status,
    });
  }
  return res.json() as Promise<T>;
}

export const api = {
  hello: () =>
    req<Session>('/api/device/hello', {
      method: 'POST',
      body: JSON.stringify({ deviceId: deviceId(), mac: deviceMac() }),
    }),

  channels: () => req<{ categories: Category[]; channels: Channel[] }>('/api/channels'),

  epg: (streamId: number) => req<{ listings: EpgEntry[] }>(`/api/epg/${streamId}`),

  play: (streamId: number, relay = false) =>
    req<{ url: string; relayed?: boolean }>(
      `/api/play/${streamId}${relay || needsRelay() ? '?relay=1' : ''}`,
    ),

  appVersion: () =>
    req<{ version: string; bundle?: string | null; minShellVersion?: number }>('/api/app/version'),

  preview: (streamId: number) =>
    req<{ url: string | null; ageMs?: number | null; off?: boolean; restricted?: boolean }>(
      `/api/preview/${streamId}`,
    ),

  weather: () => req<Weather>('/api/weather'),

  homeConfig: () => req<HomeConfig>('/api/app/home'),

  vod: () => req<{ categories: Category[]; items: VodItem[] }>('/api/vod'),

  vodDetail: (kind: 'movie' | 'series', id: number) => req<VodDetail>(`/api/vod/${kind}/${id}`),

  vodPlay: (kind: 'movie' | 'episode', id: number, ext = 'm3u8', relay = false) =>
    req<{ url: string; relayed?: boolean }>(
      `/api/vod/play/${kind}/${id}?ext=${encodeURIComponent(ext)}${
        relay || needsRelay() ? '&relay=1' : ''
      }`,
    ),

  billingStatus: () => req<BillingStatus>('/api/billing/status'),

  buyPass: (days: number) =>
    req<{ ok: boolean; payment: PaymentOrder }>('/api/billing/buy', {
      method: 'POST',
      body: JSON.stringify({ days }),
    }),

  payStatus: (orderNo: string) =>
    req<{ order: PaymentOrder; billing: BillingStatus }>(
      `/api/pay/status/${encodeURIComponent(orderNo)}`,
    ),

  menu: () => req<{ categories: { name: string; items: MenuItem[] }[] }>('/api/service/menu'),

  order: (items: { id: number; qty: number }[], note?: string) =>
    req<{ ok: boolean; orderId: number; total: number; payment: PaymentOrder | null }>('/api/service/order', {
      method: 'POST',
      body: JSON.stringify({ items, note }),
    }),

  notices: () =>
    req<{ notices: { id: number; title: string; body: string | null }[] }>('/api/notices'),

  adultStatus: () => req<{ available: boolean; unlocked: boolean }>('/api/adult/status'),

  /**
   * Exchange a PIN for an unlock.
   *
   * Every failure mode is distinguished, because the screen has to say
   * something different for each: a wrong PIN counts down, a lockout has to
   * name a wait, and an unavailable section means the box was never entitled.
   */
  async adultUnlock(pin: string): Promise<
    { ok: true } | { ok: false; reason: 'wrong'; remaining?: number } | { ok: false; reason: 'locked'; retryAfterMs: number } | { ok: false; reason: 'unavailable' }
  > {
    const res = await send('/api/adult/unlock', { method: 'POST', body: JSON.stringify({ pin }) });
    let body: any = {};
    try {
      body = await res.json();
    } catch {
      /* an empty body still has a status code to go on */
    }
    if (res.ok && body.token) {
      adultToken = body.token;
      return { ok: true };
    }
    if (res.status === 429) return { ok: false, reason: 'locked', retryAfterMs: body.retryAfterMs ?? 0 };
    if (res.status === 403) return { ok: false, reason: 'unavailable' };
    return { ok: false, reason: 'wrong', remaining: body.remaining };
  },

  async adultLock(): Promise<void> {
    if (!adultToken) return;
    try {
      await send('/api/adult/lock', { method: 'POST' });
    } catch {
      /* the token expires on its own; locking locally is what matters */
    }
    adultToken = null;
  },
};
