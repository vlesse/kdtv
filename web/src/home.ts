import { api, type HomeBackground, type HomeConfig, type Session, type Weather } from './api';
import { h } from './ui';
import { t, tIn, lang, LANG_NAMES } from './i18n';

/**
 * The launcher.
 *
 * Hotel TVs all converge on the same shape for good reason: a guest who has
 * just walked in should see where they are and four large things to press,
 * not a wall of content. Browsing lives one level down.
 */

// ---------------------------------------------------------------- icons

export type IconName = 'tv' | 'film' | 'cast' | 'grid' | 'building' | 'map' | 'star' | 'lock';

/*
 * 图标是画出来的，不是打包进来的图片。
 *
 * 这一套是照着批过的那张稿子一笔一笔描的：带天线的电视、场记板、投屏、
 * 餐盖加一只手、信息、折叠地图加图钉、锁。画成路径而不是发图片，是因为这东西
 * 要在 1366 到 4K 的电视上都清楚，还要跟着焦点变色 —— 而且一个字节不下载。
 *
 * **挖空的地方是真挖穿的**（场记板的斜纹、餐盖上的高光、图钉的孔、i 字）：
 * 用 mask 做，不是拿底色去盖。这条导航条是半透明压在照片上的，底下每处颜色
 * 都不一样，拿颜色去盖换张照片就露馅。
 */
let maskSeq = 0;

const ICON_MARKUP: Record<IconName, () => string> = {
  tv: () => `
    <path d="M22 6 L32 18.5 L42 6" stroke="currentColor" stroke-width="4.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="5.2" y="18.5" width="53.6" height="34" rx="5.5" stroke="currentColor" stroke-width="4.3" fill="none"/>
    <circle cx="49" cy="27.5" r="3" fill="currentColor"/>
    <path d="M22 58.5 H42" stroke="currentColor" stroke-width="4.3" stroke-linecap="round"/>`,

  film: () => masked(`
    <g transform="rotate(-14 32 12)">
      <rect x="3" y="3" width="58" height="15" rx="2.6" fill="#fff"/>
      <path d="M13 3 L8 18 M24 3 L19 18 M35 3 L30 18 M46 3 L41 18 M57 3 L52 18" stroke="#000" stroke-width="4.4"/>
    </g>
    <path d="M4 25h56a5 5 0 0 1 5 5v27a5 5 0 0 1-5 5H4a5 5 0 0 1-5-5V30a5 5 0 0 1 5-5z" fill="#fff"/>
    <path d="M25 32 L25 55 L45 43.5 Z" fill="#000"/>`),

  cast: () => `
    <g fill="none" stroke="currentColor" stroke-linecap="round">
      <path d="M17 13.5a3.4 3.4 0 0 1 3.4-3.4h35.2a3.4 3.4 0 0 1 3.4 3.4v28.2a3.4 3.4 0 0 1-3.4 3.4H45" stroke-width="4.3"/>
      <path d="M7 53.5a4.5 4.5 0 0 1 4.5 4.5" stroke-width="4"/>
      <path d="M7 45a13 13 0 0 1 13 13" stroke-width="4"/>
      <path d="M7 36.5A21.5 21.5 0 0 1 28.5 58" stroke-width="4"/>
    </g>
    <path d="M36.5 44 L46 58 H27 Z" fill="currentColor" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/>`,

  grid: () => masked(`
    <rect x="30" y="5" width="4" height="7" rx="2" fill="#fff"/>
    <path d="M9 37.5a23 23 0 0 1 46 0z" fill="#fff"/>
    <path d="M19.5 34a14.5 14.5 0 0 1 11-13" stroke="#000" stroke-width="2.6" fill="none" stroke-linecap="round"/>
    <rect x="5" y="39" width="54" height="5.2" rx="2.6" fill="#fff"/>
    <path d="M7 52.5c4.6 4.3 9.7 6.4 15.2 6.4h15c2 0 3.1-1.1 3.1-2.5 0-1.4-1.1-2.5-3.1-2.5h-9.1c-2.8 0-4.7-1.5-6.9-3.4-2.2-2-4.4-3.1-7-3.1-2.8 0-5.1 1.7-7.2 5.1z" fill="#fff"/>`),

  building: () => masked(`
    <circle cx="32" cy="33" r="29" fill="#fff"/>
    <path d="M35.6 16.4a4 4 0 1 1-1.5 7.9 4 4 0 0 1 1.5-7.9zM27.4 47.2l3.1-13.6c.2-.9-.1-1.3-.8-1.3h-2.4l.6-2.7 8.8-1.1-3.7 16.7c-.2.9.1 1.3.8 1.3h2.4l-.6 2.7-8.8 1.1z" fill="#000"/>`),

  map: () => masked(`
    <g fill="none" stroke="#fff" stroke-width="4.3" stroke-linejoin="round">
      <path d="M4 16 L21 9.6 L43 16 L60 9.6 V52 L43 58.4 L21 52 L4 58.4 Z"/>
      <path d="M21 9.6 V52 M43 16 V58.4"/>
    </g>
    <path d="M45 0a12.6 12.6 0 0 0-12.6 12.6c0 8.4 12.6 20.4 12.6 20.4s12.6-12 12.6-20.4A12.6 12.6 0 0 0 45 0z" fill="#000"/>
    <path d="M45 2.6a10 10 0 0 0-10 10c0 7 10 17 10 17s10-10 10-17a10 10 0 0 0-10-10z" fill="#fff"/>
    <circle cx="45" cy="12.2" r="3.5" fill="#000"/>`),

  lock: () => masked(`
    <path d="M20.5 28.5V20a11.5 11.5 0 0 1 23 0v8.5" stroke="#fff" stroke-width="4.3" fill="none" stroke-linecap="round"/>
    <rect x="10" y="28" width="44" height="32" rx="5" fill="#fff"/>
    <circle cx="32" cy="41" r="4.2" fill="#000"/>
    <path d="M32 43.5 L32 50" stroke="#000" stroke-width="4.2" stroke-linecap="round"/>`),

  star: () => `
    <path d="M32 5 L40 24 L61 26 L45 40 L50 60 L32 49 L14 60 L19 40 L3 26 L24 24 Z"
          fill="none" stroke="currentColor" stroke-width="4.3" stroke-linejoin="round"/>`,
};

/**
 * 白的留下、黑的挖掉，最后整块涂成 currentColor。
 *
 * mask 的 id 得是全局唯一的：一屏上七个图标同时在，重名的话后面的会去引用
 * 前面那块 mask，图形就串了。
 */
function masked(inner: string): string {
  const id = `ic${++maskSeq}`;
  return (
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">` +
    `<rect width="64" height="64" fill="#000"/>${inner}</mask>` +
    `<rect width="64" height="64" fill="currentColor" mask="url(#${id})"/>`
  );
}

export function icon(name: IconName): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = (ICON_MARKUP[name] ?? ICON_MARKUP.star)();
  return svg;
}

const WEATHER_GLYPH: Record<string, string> = {
  sun: '☀',
  'sun-cloud': '⛅',
  cloud: '☁',
  fog: '🌫',
  rain: '🌧',
  snow: '❄',
  storm: '⛈',
};

// ------------------------------------------------------------ background

/** Absolute http(s), or a path on this origin. Quotes and parens stripped so a
    mistyped value cannot break out of the url() and inject other declarations. */
function safeUrl(raw: unknown): string | null {
  const url = String(raw ?? '')
    .trim()
    .replace(/["'()\\]/g, '');
  if (!url) return null;
  if (url.startsWith('/')) return url;
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Start the loop, and keep it going for as long as the launcher is up.
 *
 * A single play() at boot is not enough, and neither is giving up once it has
 * played. The first attempt is refused often enough to matter - the page is
 * still hidden, the box has just woken, the WebView is mid-layout - and the
 * refusal is silent. Worse, a loop that started can still be stopped later:
 * a browser suspends muted video while the page is hidden, and a box in a room
 * is hidden constantly, every time the guest changes input, every time the
 * panel sleeps. Nothing resumes it on its own, and what is left is one frozen
 * frame behind the launcher for the rest of the stay.
 *
 * So the watchdog lives as long as the element does. Returns its disposer.
 */
function keepPlaying(video: HTMLVideoElement): () => void {
  let released = false;

  const attempt = () => {
    if (!released) void video.play().catch(() => {});
  };
  // Only chase it while the page can actually show it. Retrying into a hidden
  // page is how a play/suspend/pause cycle turns into a spin.
  const attemptIfVisible = () => {
    if (!document.hidden) attempt();
  };

  video.addEventListener('canplay', attemptIfVisible);
  // Nothing here ever pauses this deliberately, so a pause is always something
  // to undo - the suspend above, or a box-level policy we cannot see.
  video.addEventListener('pause', attemptIfVisible);
  document.addEventListener('visibilitychange', attemptIfVisible);
  // A remote keypress is a user gesture, which lifts the policy outright.
  document.addEventListener('keydown', attempt);

  const stop = () => {
    released = true;
    video.removeEventListener('canplay', attemptIfVisible);
    video.removeEventListener('pause', attemptIfVisible);
    document.removeEventListener('visibilitychange', attemptIfVisible);
    document.removeEventListener('keydown', attempt);
  };

  // A source that will not decode is not going to start on the tenth try, and
  // the launcher has already fallen back to its gradient by then.
  video.addEventListener('error', stop, { once: true });

  attempt();
  return stop;
}

/**
 * Hand the decoder back, now rather than eventually.
 *
 * Dropping the element and waiting for the collector is not enough: the media
 * element keeps its decoder and its connection until it is actually released,
 * and a cheap box has one or two decoders in total - the next thing the guest
 * presses is a channel that needs one. Clearing the source and calling load()
 * is what releases it.
 */
function releaseVideo(video: HTMLVideoElement) {
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.remove();
}

/**
 * Paint whatever the property configured behind the launcher.
 *
 * A video is a real `<video>` rather than a CSS background because there is no
 * CSS route to one, and because a set-top box needs the element's own hints -
 * muted (autoplay is refused without it), playsinline, and preload metadata so
 * a slow box paints the poster instead of black.
 *
 * Returns whatever has to be undone when the launcher goes away, or null.
 */
function paintBackground(
  backdrop: HTMLElement,
  photo: HTMLElement,
  bg: HomeBackground | undefined,
  legacy: string | null,
): (() => void) | null {
  const url = safeUrl(bg?.url) ?? (bg ? null : safeUrl(legacy));
  if (!url || bg?.type === 'none') return null;

  if (bg?.type === 'video') {
    const poster = safeUrl(bg.poster);
    const video = h('video', {
      class: 'launcher-video',
      src: url,
      autoplay: '',
      loop: '',
      muted: '',
      playsinline: '',
      preload: 'auto',
      poster: poster ?? undefined,
    }) as HTMLVideoElement;
    // The attribute alone is not always enough on Android WebView; the
    // property is what the autoplay policy actually reads.
    video.muted = true;

    // If the box cannot play it, fall back to the built-in gradient rather
    // than leaving a black rectangle in front of the guest.
    video.addEventListener('error', () => {
      video.remove();
      delete backdrop.dataset.photo;
      delete photo.dataset.on;
    });
    photo.append(video);
    photo.dataset.on = 'video';
    backdrop.dataset.photo = 'true';
    const stopWatch = keepPlaying(video);
    // The watchdog holds listeners on `document`, which outlives this view -
    // dropping the element without this would leave them running for the rest
    // of the session, one set per visit to the launcher.
    return () => {
      stopWatch();
      releaseVideo(video);
    };
  }

  photo.style.setProperty('--bg-photo', `url("${url}")`);
  photo.dataset.on = 'image';
  // The scrim keys off the backdrop, which is a sibling of the photo layer -
  // it must stay outside it so the colour grading below does not wash out the
  // very gradient that keeps the tiles legible.
  backdrop.dataset.photo = 'true';
  return null;
}

// ----------------------------------------------------------------- view

export interface Tile {
  id: string;
  icon: IconName;
  /** 大字那一行的 i18n key。两行字都从它来。 */
  key: string;
  go: () => void;
}

export function launcherView(
  session: Session | null,
  tiles: Tile[],
  onLang: () => void,
): HTMLElement {
  const clockEl = h('span', { class: 'lb-time' });
  const dateEl = h('span', { class: 'lb-date' });
  const weatherEl = h('div', { class: 'lb-weather' });
  const welcomeEl = h('div', { class: 'lb-welcome', text: t('home.welcome') });

  function tick() {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    clockEl.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    // Named from our own dictionary rather than Intl: a box whose locale data
    // lacks Khmer silently falls back to something else entirely, and the
    // weekday would come out in a language nobody chose.
    const weekday = t(`day.${d.getDay()}`);
    dateEl.innerHTML = '';
    dateEl.append(
      h('span', { text: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }),
      h('span', { text: weekday }),
    );
  }

  const bar = h(
    'header',
    { class: 'launcher-bar' },
    welcomeEl,
    h(
      'div',
      { class: 'lb-room' },
      h('span', { class: 'lb-room-label', text: `${t('home.room')}：` }),
      h('span', { class: 'lb-room-value', text: session?.room?.id ?? t('home.noRoom') }),
    ),
    h('div', { class: 'lb-clock' }, clockEl, dateEl),
    h(
      'div',
      { class: 'lb-right' },
      weatherEl,
      h('button', { class: 'pill lang focusable', text: LANG_NAMES[lang()], onclick: onLang }),
    ),
  );

  // Each tile sits in its own slot. The slot carries the entrance animation
  // and the grid column; the button carries the focus lift. Keeping them apart
  // matters: an animation with a fill mode outranks ordinary declarations, so
  // a tile that animated itself in could never be moved by :focus afterwards.
  const row = h(
    'div',
    { class: 'tiles' },
    ...tiles.map((tile, i) =>
      h(
        'div',
        { class: 'tile-slot', style: `--i:${i}` },
        h(
          'button',
          {
            class: 'tile focusable',
            'data-autofocus': i === 0 ? '' : undefined,
            onclick: tile.go,
          },
          h('span', { class: 'tile-icon' }, icon(tile.icon)),
          /*
           * 两行：上面英文，下面客人选的语言。
           *
           * 英文当标题，是因为在这类场所它是除了图标之外唯一人人认得出的一行；
           * 客人本来就选了语言，第二行才是给他读的。客人选的就是英文时，
           * 第二行没有意义，干脆不渲染 —— 不是渲染成空的，空元素照样占位置，
           * 那一格的图标和字就会比旁边高一截。
           */
          h('span', { class: 'tile-label', text: tIn('en', tile.key) }),
          lang() === 'en' ? null : h('span', { class: 'tile-sub', text: t(tile.key) }),
        ),
      ),
    ),
  );
  // 条子只管自己那层毛玻璃。焦点那一格比它高，会冒到条子外面去，
  // 所以这里不能裁剪内容 —— 样式表里也没给它 overflow。
  const band = h('div', { class: 'tile-band' }, row);

  const photo = h('div', { class: 'launcher-photo' });
  const backdrop = h('div', { class: 'launcher-bg' }, photo);
  const root = h('div', { class: 'launcher screen' }, backdrop, bar, h('div', { class: 'spacer' }), band);

  tick();
  const timer = window.setInterval(tick, 20_000);

  // Set once the launcher has been replaced. The config below arrives after
  // first paint, and a guest can be off the launcher before it lands - without
  // this the response would build a background video into a detached tree,
  // where it would keep decoding with nothing left to tear it down.
  let gone = false;
  let releaseBackground: (() => void) | null = null;

  root.addEventListener('remove-hook', () => {
    gone = true;
    clearInterval(timer);
    releaseBackground?.();
    releaseBackground = null;
  });

  // Dressing arrives after the first paint; the launcher is useful without it.
  api
    .homeConfig()
    .then((cfg: HomeConfig) => {
      if (gone) return;
      releaseBackground = paintBackground(backdrop, photo, cfg.background, cfg.backgroundUrl);
      // An operator-written welcome replaces the translated one, since they
      // wrote it in the language they meant.
      if (cfg.welcomeText) welcomeEl.textContent = cfg.welcomeText;
    })
    .catch(() => {});

  api
    .weather()
    .then((w: Weather) => {
      if (!w || w.unavailable) return;
      weatherEl.replaceChildren(
        h('span', { class: 'lb-wx-icon', text: WEATHER_GLYPH[w.icon] ?? '☀' }),
        h('span', { text: `${t(`weather.${w.key}`)} ${w.temp}°C` }),
      );
    })
    .catch(() => {});

  return root;
}
