import { api, type Episode, type VodDetail, type VodItem } from './api';
import { h, tint, toast } from './ui';
import { focusFirst, onBack } from './nav';
import { t } from './i18n';
import { createPlayback } from './hls';
import { createCurtain } from './curtain';
import { isPaymentRequired, showPaywall } from './paywall';

/**
 * Films and series.
 *
 * The panel stores a film and a series episode in different tables, but from
 * the sofa they are the same thing - something with a poster that you press
 * OK on - so the difference only survives as far as which URL gets played.
 */

// ---------------------------------------------------------------- resume

/**
 * Where the viewer got to. A dormitory TV is shared and gets switched off
 * mid-episode constantly, so resuming matters more here than it would on a
 * personal device. Kept per box in localStorage; nothing to sync, nothing to
 * lose if it is cleared.
 */
const resumeKey = (kind: string, id: number) => `ott.resume.${kind}.${id}`;

function saveResume(kind: string, id: number, seconds: number, duration: number) {
  try {
    // Near the end it is finished, not paused - offering to resume the last
    // 30 seconds of a film is just noise.
    if (!duration || seconds < 30 || seconds > duration - 30) {
      localStorage.removeItem(resumeKey(kind, id));
    } else {
      localStorage.setItem(resumeKey(kind, id), String(Math.floor(seconds)));
    }
  } catch {
    /* private mode - resume is a convenience, not a requirement */
  }
}

function loadResume(kind: string, id: number): number {
  try {
    return Number(localStorage.getItem(resumeKey(kind, id))) || 0;
  } catch {
    return 0;
  }
}

/** Which episode of a series this box was last on, so "Putar" continues it. */
const lastEpKey = (seriesId: number) => `ott.lastep.${seriesId}`;

function saveLastEpisode(seriesId: number, index: number) {
  try {
    localStorage.setItem(lastEpKey(seriesId), String(index));
  } catch {
    /* see saveResume */
  }
}

function loadLastEpisode(seriesId: number, count: number): number {
  try {
    const i = Number(localStorage.getItem(lastEpKey(seriesId)));
    return Number.isInteger(i) && i >= 0 && i < count ? i : 0;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------ cards

export function posterCard(item: VodItem, onOpen: (item: VodItem) => void): HTMLElement {
  const tone = tint(item.name);
  return h(
    'button',
    { class: 'poster focusable', onclick: () => onOpen(item) },
    h(
      'div',
      { class: 'poster-art', style: `--c1:${tone.c1};--c2:${tone.c2}` },
      item.icon
        ? h('img', { src: item.icon, alt: '', loading: 'lazy' })
        : h('span', { class: 'card-initial', text: tone.initial }),
      item.kind === 'series' ? h('span', { class: 'poster-tag', text: t('vod.series') }) : null,
      item.rating > 0 ? h('span', { class: 'poster-rating', text: item.rating.toFixed(1) }) : null,
    ),
    h('div', { class: 'poster-title', text: item.name }),
    h('div', { class: 'poster-sub', text: [item.year, item.categoryName].filter(Boolean).join(' · ') }),
  );
}

// ----------------------------------------------------------------- detail

const mmss = (s: number) => {
  if (!Number.isFinite(s) || s < 0) return '00:00';
  const total = Math.floor(s);
  const h2 = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h2 ? `${h2}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
};

export function detailView(
  item: VodItem,
  play: (detail: VodDetail, episodeIndex: number) => void,
  exit: () => void,
): HTMLElement {
  const body = h('div', { class: 'body' });
  /*
   * The film's own poster, blown up behind it.
   *
   * It arrives with the detail rather than with the card, so it fades in when
   * the image has actually decoded - a backdrop that pops in half-drawn is
   * worse than one that never appears. It stays hidden until then, which is
   * also what a title with no artwork gets.
   */
  const backdrop = h('div', { class: 'detail-backdrop' });
  const root = h('div', { class: 'screen detail-screen' }, backdrop, body);

  onBack(() => {
    exit();
    return true;
  });

  body.append(
    h('div', { class: 'centre' }, h('div', { class: 'spinner' })),
  );

  api
    .vodDetail(item.kind, item.id)
    .then((d) => {
      const episodes = d.episodes ?? [];
      const startAt = episodes.length ? loadLastEpisode(d.id, episodes.length) : 0;
      const resumed = loadResume(
        episodes.length ? 'episode' : 'movie',
        episodes.length ? episodes[startAt].id : d.id,
      );
      const resumeLabel = episodes.length
        ? t('vod.resumeEp', { e: episodes[startAt].num || startAt + 1, t: mmss(resumed) })
        : t('vod.resume', { t: mmss(resumed) });
      const facts = [d.year, d.genre, d.duration, d.rating ? `★ ${d.rating.toFixed(1)}` : '']
        .filter(Boolean)
        .join('  ·  ');

      const actions = h(
        'div',
        { class: 'detail-actions' },
        h('button', {
          class: 'btn focusable',
          'data-autofocus': '',
          text: resumed ? resumeLabel : t('vod.play'),
          onclick: () => play(d, startAt),
        }),
        h('button', { class: 'btn ghost focusable', text: t('player.back'), onclick: exit }),
      );

      const hero = h(
        'section',
        { class: 'detail' },
        h(
          'div',
          { class: 'detail-poster' },
          d.cover ? h('img', { src: d.cover, alt: '' }) : h('span', { class: 'card-initial', text: tint(d.name).initial }),
        ),
        h(
          'div',
          { class: 'detail-info' },
          h('div', { class: 'kicker' }, h('span', { class: 'dot' }), d.kind === 'series' ? t('vod.series') : t('vod.film')),
          h('h1', { text: d.name }),
          facts ? h('p', { class: 'detail-facts', text: facts }) : null,
          d.plot ? h('p', { class: 'detail-plot', text: d.plot }) : null,
          d.cast ? h('p', { class: 'muted', text: `${t('vod.cast')}: ${d.cast}` }) : null,
          d.director ? h('p', { class: 'muted', text: `${t('vod.director')}: ${d.director}` }) : null,
          actions,
        ),
      );

      body.replaceChildren(hero);

      if (d.cover) {
        const art = new Image();
        art.addEventListener('load', () => {
          backdrop.style.setProperty('--art', `url("${d.cover}")`);
          backdrop.dataset.on = '';
        });
        art.src = d.cover;
      }

      if (episodes.length) {
        body.append(
          h('div', { class: 'rail-head' }, h('h2', { text: t('vod.episodes', { n: episodes.length }) })),
          h(
            'div',
            { class: 'episodes' },
            ...episodes.map((ep, i) =>
              h(
                'button',
                { class: 'episode focusable', onclick: () => play(d, i) },
                h('span', { class: 'episode-num', text: String(ep.num || i + 1) }),
                h('span', { class: 'episode-title', text: ep.title }),
              ),
            ),
          ),
        );
      }

      focusFirst(root);
    })
    .catch((err) => {
      console.error(err);
      body.replaceChildren(
        h(
          'div',
          { class: 'centre' },
          h(
            'div',
            {},
            h('p', { class: 'muted', text: t('vod.detailFail') }),
            h('button', { class: 'btn focusable', 'data-autofocus': '', text: t('player.back'), onclick: exit }),
          ),
        ),
      );
      focusFirst(root);
    });

  return root;
}

// ----------------------------------------------------------------- player

export function vodPlayerView(
  detail: VodDetail,
  startIndex: number,
  exit: () => void,
): HTMLElement {
  const episodes: Episode[] = detail.episodes ?? [];
  let index = Math.max(0, Math.min(startIndex, Math.max(0, episodes.length - 1)));
  let hideTimer: number | undefined;

  const video = h('video', { autoplay: '', playsinline: '' }) as HTMLVideoElement;
  const curtain = createCurtain();
  curtain.attach(video);
  // A fatal decode/network error is the same event to the viewer as a source
  // that never opened, so it lands on the curtain rather than only in a toast
  // that fades off a black screen.
  /** Whether this title has already fallen back to the relay. */
  let viaRelay = false;
  const playback = createPlayback(video, {
    onRecovering: () => curtain.recovering(),
    onRecovered: () => curtain.hide(),
    onFatal: (msg) => {
      // Same last chance as live: a source whose CDN sends no CORS header is
      // unreadable from a page, and indistinguishable from one that is simply
      // down, so it is worth one attempt through the relay before saying so.
      if (!viaRelay) {
        viaRelay = true;
        curtain.recovering();
        void start(true);
        return;
      }
      curtain.fail(msg);
      toast(msg);
    },
  });
  curtain.onRetry(() => void start());

  const title = h('div', { class: 'now-title', text: detail.name });
  const sub = h('div', { class: 'now-sub' });
  const elapsed = h('span', { class: 'time', text: '00:00' });
  const total = h('span', { class: 'time', text: '00:00' });
  const fill = h('span', { class: 'seek-fill' });

  const playBtn = h('button', {
    class: 'btn focusable',
    text: t('vod.pause'),
    onclick: () => togglePlay(),
  });

  /*
   * 进度条是**进播放器时默认选中的那个东西**，不是播放键。
   *
   * 遥控器上先按的一定是左右键 —— 那是「快进快退」在所有电视上的意思。
   * 原来焦点落在播放键上，左右键只是在几个按钮之间挪，客人按了半天
   * 什么也没发生，只会得出「这播放器不能快进」的结论。播放键往下一格就是。
   */
  const seekBar = h(
    'span',
    { class: 'seek-bar focusable', tabindex: '0', 'data-autofocus': '' },
    fill,
  );

  const nextBtn = h('button', {
    class: 'btn ghost focusable',
    text: t('vod.next'),
    onclick: () => selectEpisode(index + 1),
  });

  const overlay = h(
    'div',
    { class: 'player-overlay' },
    h('div', { class: 'player-top' }, h('div', {}, title, sub)),
    h(
      'div',
      { class: 'player-bottom' },
      h('div', { class: 'seek' }, elapsed, seekBar, total),
      h('div', { class: 'seek-hint', text: t('vod.seekHint') }),
      h(
        'div',
        { style: 'display:flex;gap:.75rem;align-items:center' },
        playBtn,
        episodes.length > 1 ? nextBtn : null,
        h('button', { class: 'btn ghost focusable', text: t('player.back'), onclick: leave }),
      ),
    ),
  );

  const root = h('div', { class: 'player screen' }, video, curtain.el, overlay);

  // ------------------------------------------------------------- playback

  const currentKind = () => (episodes.length ? 'episode' : 'movie');
  const currentId = () => (episodes.length ? episodes[index].id : detail.id);

  function persist() {
    if (video.duration) saveResume(currentKind(), currentId(), video.currentTime, video.duration);
  }

  async function selectEpisode(next: number) {
    if (!episodes.length || next < 0 || next >= episodes.length) return;
    persist();
    index = next;
    await start();
  }

  /** Same reason as the live player: episode replies can land out of order. */
  let loading = 0;

  async function start(relay = false) {
    if (!relay) viaRelay = false;
    const mine = ++loading;
    const ep = episodes[index];
    if (ep) saveLastEpisode(detail.id, index);
    sub.textContent = ep ? ep.title : [detail.year, detail.genre].filter(Boolean).join(' · ');
    nextBtn.toggleAttribute('disabled', index >= episodes.length - 1);
    curtain.show(detail.name, sub.textContent);

    try {
      const ext = (ep?.container || detail.container || 'm3u8').replace(/[^a-z0-9]/gi, '') || 'm3u8';
      const { url } = await api.vodPlay(currentKind(), currentId(), ext, relay);
      if (mine !== loading) return;
      await playback.load(url, 'vod');
      if (mine !== loading) return;

      const at = loadResume(currentKind(), currentId());
      if (at > 0) {
        // Seeking before metadata lands is silently dropped by most players.
        const seek = () => {
          video.removeEventListener('loadedmetadata', seek);
          if (mine === loading) video.currentTime = at;
        };
        if (video.readyState >= 1) seek();
        else video.addEventListener('loadedmetadata', seek);
      }
    } catch (err) {
      if (mine !== loading) return;

      /*
       * 402 is not a failure. It is the server saying "this costs money", and
       * the answer to it is a price list - not the red curtain that tells a
       * guest something is broken and to call the front desk.
       *
       * Paying is the only way out that lands back here, so a successful
       * payment restarts playback; anything else leaves the curtain up.
       */
      if (isPaymentRequired(err)) {
        curtain.fail('');
        void showPaywall('vod', () => void start(relay));
        return;
      }

      console.error(err);
      // A film that cannot be fetched is a dead end the same way a dead
      // channel is, so it gets the same treatment rather than a toast over
      // black.
      curtain.fail(t('toast.playFail'));
    }
  }

  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    playBtn.textContent = video.paused ? t('vod.play') : t('vod.pause');
  }

  /*
   * 快进是**先画后跳**的。
   *
   * 遥控器按住不放会连发按键，一下十几次。每来一次就写一次 `currentTime`，
   * 等于让播放器连着重开十几次缓冲 —— 画面卡死，进度条一顿一顿，
   * 而客人只是想往前拖一分钟。
   *
   * 所以按键只改「要去哪儿」并立刻把进度条画过去（客人看得见自己在拖），
   * 手停下来 350 毫秒之后才真的跳一次。这也是电视上那些播放器的做法。
   */
  const SEEK_SETTLE_MS = 350;
  let pendingAt: number | null = null;
  let seekTimer: number | undefined;

  function paintProgress(at: number, dur: number) {
    elapsed.textContent = mmss(at);
    total.textContent = mmss(dur);
    fill.style.width = `${dur ? (at / dur) * 100 : 0}%`;
  }

  function aimAt(at: number) {
    const dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;

    pendingAt = Math.max(0, Math.min(dur - 1, at));
    paintProgress(pendingAt, dur);
    seekBar.dataset.seeking = 'true';
    showOverlay();

    clearTimeout(seekTimer);
    seekTimer = window.setTimeout(() => {
      if (pendingAt == null) return;
      video.currentTime = pendingAt;
      pendingAt = null;
      delete seekBar.dataset.seeking;
    }, SEEK_SETTLE_MS);
  }

  /** 往前/往后多少秒。连按是在**上一次的目标**上继续加，不是在画面位置上。 */
  function seekBy(seconds: number) {
    aimAt((pendingAt ?? video.currentTime) + seconds);
  }

  /** 跳到片长的某个比例 —— 数字键和鼠标点进度条都走这里。 */
  function seekToFraction(f: number) {
    if (!Number.isFinite(video.duration)) return;
    aimAt(video.duration * Math.max(0, Math.min(1, f)));
  }

  // 有鼠标/飞鼠的盒子，以及在电脑上测的时候：直接点进度条。
  seekBar.addEventListener('click', (e) => {
    const r = seekBar.getBoundingClientRect();
    if (r.width > 0) seekToFraction(((e as MouseEvent).clientX - r.left) / r.width);
  });

  function leave() {
    persist();
    playback.destroy();
    exit();
  }

  // --------------------------------------------------------------- chrome

  function showOverlay() {
    overlay.dataset.hidden = 'false';
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      // Hiding the chrome while paused reads as a frozen picture, so only do
      // it once something is actually moving.
      if (!video.paused) overlay.dataset.hidden = 'true';
    }, 6000);
  }

  video.addEventListener('timeupdate', () => {
    // 正在拖的时候不要把进度条拽回播放位置 —— 那看起来就像「拖不动」。
    if (pendingAt != null) return;
    paintProgress(video.currentTime, video.duration);
  });
  video.addEventListener('pause', () => {
    playBtn.textContent = t('vod.play');
    persist();
  });
  video.addEventListener('play', () => (playBtn.textContent = t('vod.pause')));
  video.addEventListener('ended', () => {
    if (index < episodes.length - 1) selectEpisode(index + 1);
    else leave();
  });

  /*
   * On the document and in capture, for the same reason the live player is:
   * a listener bound to this view's root goes deaf the moment focus falls out
   * of it, and then the controls never come back no matter what is pressed.
   */
  function onKeyDown(e: KeyboardEvent) {
    const k = e.key;
    // 控件是不是本来就藏着的，要在 showOverlay() 之前问 —— 它下一行就把藏的掀开了。
    const wasHidden = overlay.dataset.hidden === 'true';
    showOverlay();

    const eat = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    // 遥控器上的专用键。有这几个键的遥控器不多，但有的人第一下就按它。
    if (k === 'MediaFastForward') return eat(), seekBy(30);
    if (k === 'MediaRewind') return eat(), seekBy(-30);
    if (k === 'MediaPlayPause' || k === 'MediaPlay' || k === 'MediaPause') return eat(), togglePlay();

    // 数字键跳到片长的十分之几 —— 电视上「从中间某处开始看」最快的办法，
    // 拿方向键从头拖过去要按几十下。
    if (/^[0-9]$/.test(k)) return eat(), seekToFraction(Number(k) / 10);

    /*
     * 左右键：焦点在进度条上时快退快进；**控件本来藏着的时候也算**——
     * 画面上什么都没有的时候，左右键只可能是「快进快退」的意思。
     * 其余情况（控件亮着、焦点在按钮那一行）左右键还是挪焦点，
     * 不然遥控器就废了一半。
     */
    const onSeekBar = (document.activeElement as HTMLElement | null)?.classList.contains('seek-bar');
    if ((onSeekBar || wasHidden) && (k === 'ArrowLeft' || k === 'ArrowRight')) {
      eat();
      if (!onSeekBar) seekBar.focus();
      seekBy(k === 'ArrowRight' ? 15 : -15);
      return;
    }
    if (onSeekBar && (k === 'Enter' || k === 'NumpadEnter')) {
      eat();
      togglePlay();
    }
  }

  document.addEventListener('keydown', onKeyDown, true);

  onBack(() => {
    leave();
    return true;
  });

  root.addEventListener('remove-hook', () => {
    document.removeEventListener('keydown', onKeyDown, true);
    clearTimeout(hideTimer);
    persist();
    playback.destroy();
  });

  start();
  showOverlay();
  queueMicrotask(() => focusFirst(overlay));

  return root;
}
