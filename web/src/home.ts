import { api, type HomeBackground, type HomeConfig, type Session, type Weather } from './api';
import { h } from './ui';
import { t, lang, LANG_NAMES } from './i18n';

/**
 * The launcher.
 *
 * Hotel TVs all converge on the same shape for good reason: a guest who has
 * just walked in should see where they are and four large things to press,
 * not a wall of content. Browsing lives one level down.
 */

// ---------------------------------------------------------------- icons

export type IconName = 'tv' | 'film' | 'grid' | 'building' | 'star' | 'lock';

/** A rounded square, the shape the grid icon repeats four times. */
function roundedSquare(x: number, y: number, size: number, r: number): string {
  const side = size - 2 * r;
  return (
    `M${x + r} ${y}h${side}a${r} ${r} 0 0 1 ${r} ${r}` +
    `v${side}a${r} ${r} 0 0 1 ${-r} ${r}` +
    `h${-side}a${r} ${r} 0 0 1 ${-r} ${-r}` +
    `v${-side}a${r} ${r} 0 0 1 ${r} ${-r}z`
  );
}

/**
 * Outline icons, drawn rather than shipped.
 *
 * These trace the set the property supplied: a retro TV with antennae, a film
 * strip with sprocket holes, four rounded squares, and a pair of buildings
 * with a sloped roofline. Drawing them as paths rather than serving the
 * artwork keeps them crisp at any tile size, recolourable on focus, and worth
 * nothing in download.
 */
export function icon(name: IconName): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const paths: Record<IconName, string[]> = {
    tv: [
      // Screen body, then the V of the antennae, then the foot.
      'M12 15h24a4 4 0 0 1 4 4v17a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4V19a4 4 0 0 1 4-4z',
      'M24 15L16 6M24 15l8-9',
      'M15 44h18',
    ],
    film: [
      // Strip, the two sprocket bands, the perforations, then the play mark.
      'M9 11h30a2 2 0 0 1 2 2v22a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V13a2 2 0 0 1 2-2z',
      'M7 17h34M7 31h34',
      'M13 11v6M19 11v6M25 11v6M31 11v6M37 11v6',
      'M13 31v6M19 31v6M25 31v6M31 31v6M37 31v6',
      'M21 19.5l7.5 4.5-7.5 4.5z',
    ],
    // A padlock, for the section that stays shut until a PIN opens it.
    lock: [
      'M12 21h24a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3H12a3 3 0 0 1-3-3V24a3 3 0 0 1 3-3z',
      'M16 21v-6a8 8 0 0 1 16 0v6',
      'M24 29v6',
    ],
    grid: [
      roundedSquare(7, 7, 14, 3),
      roundedSquare(27, 7, 14, 3),
      roundedSquare(7, 27, 14, 3),
      roundedSquare(27, 27, 14, 3),
    ],
    building: [
      'M5 42h38',
      'M9 42V24h13v18',
      'M12 28h7M12 32h7M12 36h7',
      'M22 42V15l15-7v34',
    ],
    star: ['M24 7l5.2 10.6 11.7 1.7-8.5 8.2 2 11.6L24 33.6l-10.4 5.5 2-11.6-8.5-8.2 11.7-1.7z'],
  };

  for (const d of paths[name]) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('d', d);
    svg.append(el);
  }
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
  label: string;
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
          h('span', { class: 'tile-label', text: tile.label }),
        ),
      ),
    ),
  );
  // The sheen clips its own highlight so the band itself can stay unclipped -
  // a focused tile lifts out of the band and needs its shadow intact.
  const band = h(
    'div',
    { class: 'tile-band' },
    h('span', { class: 'band-sheen', 'aria-hidden': 'true' }),
    row,
  );

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
