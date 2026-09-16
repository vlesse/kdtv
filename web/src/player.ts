import { api, type Channel, type TvTemplate } from './api';
import { createPlayback } from './hls';
import { createCurtain } from './curtain';
import { isPaymentRequired, showPaywall } from './paywall';
import { liveProfile, setLiveProfile, diagnosticsOn, type LiveProfile } from './hls';
import { h, hhmm, tint, toast } from './ui';
import { focus, focusFirst, onBack } from './nav';
import { t } from './i18n';

/**
 * Live player. Video is fetched straight from the panel - routing it through
 * the BFF would turn that service into the bandwidth bottleneck - while
 * everything around it (which channel, which line) still comes from the BFF.
 *
 * The controls follow a television, not a web page. Someone who has used a
 * set-top box for twenty years reaches for up/down to change channel, types a
 * number to jump to one, and expects a "last channel" key to bounce back to
 * whatever they were watching before. None of that is discoverable, and none of
 * it needs to be - it is muscle memory, and a box that does not answer it feels
 * broken in a way no amount of on-screen menu makes up for.
 */

/** How long digits stay on screen before the channel they spell is tuned. */
const NUMBER_COMMIT_MS = 2000;

/** Digits a channel number may have. Panels number into the thousands. */
const NUMBER_MAX_DIGITS = 4;

/**
 * 播放器的两副面孔。
 *
 * 模板 A（酒店门户）里，播放器是从首页点进来的一个屏幕，所以底部那个键是
 * 「返回」，按了回到上一屏。模板 B（直播优先）里**没有上一屏** —— 开机就在
 * 这儿，退无可退，所以同一个键变成「菜单」，按了拉出点播/服务/关于。
 *
 * 只有这一处行为差别，其余全部共用：一套切台逻辑、一套数字输入、一套诊断
 * 叠层。两套模板各写一遍播放器的话，下次修切台的 bug 就得修两遍，
 * 而第二遍一定会被忘掉。皮肤差异走 `data-skin`，在 CSS 里分。
 */
export interface PlayerOptions {
  /** 皮肤：`portal` 是现有样子，`live` 是模板 B 的电视条。 */
  skin?: TvTemplate;
  /** 左下角那个键的字。默认「返回」。 */
  exitLabel?: string;
  /** 每次真正换到一个台时叫一次 —— 模板 B 用它记住「关机前在看哪个台」。 */
  onTune?: (ch: Channel) => void;
}

export function playerView(
  channels: Channel[],
  startId: number,
  onExit: () => void,
  opts: PlayerOptions = {},
): HTMLElement {
  /**
   * Zapping order is by channel number, not by whatever order the panel
   * happened to answer in. Up and down have to agree with the numbers printed
   * beside them, or typing 12 and pressing down twice lands somewhere that
   * makes no sense.
   */
  const order = [...channels].sort((a, b) => (a.num || 0) - (b.num || 0));

  let current = order.find((c) => c.id === startId) ?? order[0];
  /** Where the "last channel" key goes back to. Null until the first zap. */
  let previous: Channel | null = null;
  let hideTimer: number | undefined;

  // No `muted` attribute: on a script-created element it only sets the default
  // muted state and leaves the property alone, so it never did anything here -
  // and a television wants sound. Autoplay is allowed regardless, because
  // reaching this screen took a remote press.
  const video = h('video', { autoplay: '', playsinline: '' }) as HTMLVideoElement;
  const curtain = createCurtain();
  curtain.attach(video);

  // Recovery is reported, not hidden: an interruption the player is working
  // through says so and keeps the picture, and only a genuine dead end becomes
  // a failure the viewer has to act on.
  const playback = createPlayback(video, {
    onRecovering: () => curtain.recovering(),
    onRecovered: () => curtain.hide(),
    onFatal: (msg) => {
      /*
       * Before the viewer is told a channel is gone, one attempt through the
       * relay. A few of these CDNs send no CORS header at all - three of the
       * ninety-one channels, at the last count - and a playlist a page cannot
       * read looks exactly like a dead source from in here. Only those
       * channels ever pay for the extra hop, and only after failing.
       */
      if (!viaRelay && current) {
        viaRelay = true;
        curtain.recovering();
        void tune(current, ++tuning, true);
        return;
      }
      curtain.fail(msg);
      toast(msg);
    },
  });
  /*
   * Retry goes back to the panel for a fresh URL rather than replaying the one
   * that just failed. A live URL is not durable - it is a redirect chain with
   * signed, time-limited hops behind it, and the relay token in front of it
   * expires too - so by the time a viewer has read the failure and pressed the
   * button, the thing that failed is exactly the thing that cannot work. This
   * is what the on-demand player already did; now both do.
   */
  curtain.onRetry(() => select(current));

  const title = h('div', { class: 'now-title', text: current?.name ?? '' });
  const sub = h('div', { class: 'now-sub', text: current?.categoryName ?? '' });
  const numberBadge = h('span', { class: 'pill num', text: String(current?.num ?? '') });
  const epgStrip = h('div', { class: 'epg-strip' });

  /** The digits-so-far overlay, in the corner where a television puts it. */
  const numberOsd = h('div', { class: 'zap-number', 'data-on': 'false' });

  const lastBtn = h('button', {
    class: 'btn ghost focusable',
    text: t('player.lastChannel'),
    onclick: () => toLastChannel(),
  });

  /*
   * 三档直播模式，一个按钮循环切。
   *
   * 放在播放器里而不是藏进设置页：会去调它的人，正是此刻正盯着一个卡顿画面
   * 的人。让他在卡的那一刻按一下就能换成「稳定」，比让他退出去翻菜单强。
   * 换档要重新起流，所以按完直接重调当前频道。
   */
  const PROFILE_ORDER: LiveProfile[] = ['stable', 'balanced', 'low'];
  const profileBtn = h('button', {
    class: 'btn ghost focusable',
    text: t(`player.profile.${liveProfile()}`),
    onclick: () => {
      const next = PROFILE_ORDER[(PROFILE_ORDER.indexOf(liveProfile()) + 1) % PROFILE_ORDER.length];
      setLiveProfile(next);
      profileBtn.textContent = t(`player.profile.${next}`);
      if (current) void tune(current, ++tuning);
    },
  });

  const overlay = h(
    'div',
    { class: 'player-overlay' },
    h(
      'div',
      { class: 'player-top' },
      h('div', {}, title, sub),
      h(
        'div',
        { class: 'topbar-right' },
        numberBadge,
        current?.adult ? h('span', { class: 'pill adult', text: '18+' }) : null,
        h('span', { class: 'pill live', text: t('player.live') }),
      ),
    ),
    h(
      'div',
      { class: 'player-bottom' },
      h(
        'div',
        { style: 'display:flex;gap:.75rem;align-items:center;flex-wrap:wrap' },
        h('button', {
          class: 'btn focusable',
          'data-autofocus': '',
          text: t('player.list'),
          onclick: () => toggleZapper(true),
        }),
        lastBtn,
        h('button', {
          class: 'btn ghost focusable',
          text: opts.exitLabel ?? t('player.back'),
          onclick: onExit,
        }),
        profileBtn,
        h('span', { class: 'hint-keys', text: t('player.hint') }),
      ),
      epgStrip,
    ),
  );

  /*
   * 切台黑场。
   *
   * 换台的那一两秒里，画面是上一个频道的最后一帧僵在那儿、然后跳一下变成
   * 新频道 —— 看起来像卡住了。盖一层黑，切台就成了「黑一下，出新台」，
   * 跟普通电视一样。这不是装饰，是把一个看着像故障的过程变回看着正常。
   */
  const blackout = h('div', { class: 'zap-blackout', 'data-on': 'false' });

  /*
   * 诊断叠层。
   *
   * 房间里某个台卡，站在电视前的人要能分清三件事：上行不够（带宽低、缓冲见底）、
   * 盒子解不动（丢帧高）、还是这条源本身坏（一直在重连）。这三种的处理办法
   * 完全不同，没有这些数字就只能靠猜。
   *
   * 默认不显示。后台可以整店打开（工程师上门前打开，走之前关掉），
   * 带键盘时按 i 也能开。
   */
  const diag = h('div', { class: 'diag', 'data-on': 'false' });
  let diagTimer = 0;

  function paintDiag() {
    const st = playback.stats();
    if (!st) {
      diag.textContent = '—';
      return;
    }
    const mb = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' Mbps' : Math.round(n / 1e3) + ' kbps');
    const dropPct = st.frames ? ((st.dropped / st.frames) * 100).toFixed(1) : '0.0';
    diag.replaceChildren(
      // 没有的值就不显示。很多单档直播的 playlist 不写 BANDWIDTH，
      // 打印一个「0 kbps」会让人以为是叠层坏了，而不是流里本来就没有。
      h('div', {
        text: [
          st.width && st.height ? `${st.width}×${st.height}` : null,
          st.bitrate ? mb(st.bitrate) : null,
          st.levels > 1 ? `${st.levels} 档` : null,
        ]
          .filter(Boolean)
          .join('  ') || '—',
      }),
      h('div', { text: `带宽 ${mb(st.bandwidth)}　缓冲 ${st.bufferAhead.toFixed(1)}s` }),
      h('div', { text: `丢帧 ${st.dropped}/${st.frames}（${dropPct}%）` }),
      h('div', {
        text: `${st.engine}${viaRelay ? ' · 中继' : ' · 直连'}${st.recovering ? ' · 重连中' : ''}　${liveProfile()}`,
      }),
    );
  }

  // 后台整店打开的话，一进播放器就显示。
  if (diagnosticsOn()) window.setTimeout(() => toggleDiag(true), 0);

  function toggleDiag(on?: boolean) {
    const next = on ?? diag.dataset.on !== 'true';
    diag.dataset.on = String(next);
    clearInterval(diagTimer);
    if (next) {
      paintDiag();
      diagTimer = window.setInterval(paintDiag, 1000);
    }
  }

  const zapper = h('aside', { class: 'zapper', 'data-open': 'false', 'aria-hidden': 'true' });

  function toggleZapper(open: boolean) {
    zapper.dataset.open = String(open);
    zapper.setAttribute('aria-hidden', String(!open));
    if (open) {
      showOverlay();
      focus(zapper.querySelector<HTMLElement>('.zap-row.active') ?? zapper.querySelector('.zap-row'));
    } else {
      focusFirst(overlay);
    }
  }

  function renderZapper() {
    zapper.replaceChildren(
      h('h2', { style: 'margin:0 0 .75rem;font-size:1.2rem', text: t('player.channels') }),
      ...order.map((ch) => {
        const c = tint(ch.name);
        return h(
          'button',
          {
            class: 'zap-row focusable' + (ch.id === current.id ? ' active' : ''),
            onclick: () => {
              select(ch);
              toggleZapper(false);
            },
          },
          // The number is on screen because it is what a guest types. A list
          // that hides it makes number entry a guessing game.
          h('span', { class: 'zap-num', text: String(ch.num ?? '') }),
          h(
            'span',
            { class: 'zap-logo', style: `--c1:${c.c1};--c2:${c.c2}` },
            ch.icon ? h('img', { src: ch.icon, alt: '' }) : c.initial,
          ),
          h(
            'span',
            {},
            h('div', { style: 'font-weight:700', text: ch.name }),
            h('div', { class: 'card-sub', text: ch.categoryName }),
          ),
        );
      }),
    );
  }

  async function loadEpg(ch: Channel) {
    epgStrip.replaceChildren();
    try {
      const { listings } = await api.epg(ch.id);
      if (!listings.length) return;
      const nowSec = Date.now() / 1000;
      epgStrip.replaceChildren(
        ...listings.slice(0, 8).map((e) => {
          const live = e.start && e.stop && nowSec >= e.start && nowSec < e.stop;
          return h(
            'div',
            { class: 'epg-item' + (live ? ' on-now' : '') },
            h('div', { class: 'epg-time', text: `${hhmm(e.start)} - ${hhmm(e.stop)}` }),
            h('div', { class: 'epg-title', text: e.title || t('player.noEpg') }),
          );
        }),
      );
    } catch {
      /* EPG is decoration; never let it break playback */
    }
  }

  /**
   * Which channel selection is current.
   *
   * Zapping is asynchronous twice over - the BFF has to answer, then the
   * stream has to open - and the replies do not come back in the order they
   * were asked for. Without this a viewer holding Down ends up watching
   * whichever request happened to finish last, which is rarely the channel
   * shown in the corner.
   */
  let tuning = 0;
  let zapTimer: number | undefined;
  /** Whether this channel has already fallen back to the relay. */
  let viaRelay = false;

  /**
   * Long enough that running down the list does not fire a request per press,
   * short enough that a deliberate single press feels immediate. The name and
   * the curtain update straight away regardless, so the screen never lags the
   * remote even while the request is held back.
   */
  const ZAP_DELAY_MS = 350;

  function select(ch: Channel) {
    if (ch.id !== current.id) previous = current;
    current = ch;
    viaRelay = false;
    title.textContent = ch.name;
    sub.textContent = ch.categoryName;
    numberBadge.textContent = String(ch.num ?? '');
    renderZapper();
    // Raised before the request goes out, not after it returns: the wait this
    // covers starts the moment the viewer presses the channel.
    curtain.show(ch.name, ch.categoryName);

    const mine = ++tuning;
    clearTimeout(zapTimer);
    zapTimer = window.setTimeout(() => void tune(ch, mine), ZAP_DELAY_MS);
  }

  async function tune(ch: Channel, mine: number, relay = false) {
    loadEpg(ch);
    opts.onTune?.(ch);
    blackout.dataset.on = 'true';
    try {
      const { url } = await api.play(ch.id, relay);
      if (mine !== tuning) return; // the viewer has moved on
      await playback.load(url, 'live');
      if (mine !== tuning) return;
      // 有画面了才揭开。早一帧揭开，看到的就是上一个台的最后一帧。
      blackout.dataset.on = 'false';
    } catch (err) {
      if (mine !== tuning) return;

      // Same bargain as VOD: 402 means "buy a pass", which is a price list and
      // not the failure curtain. Only reachable on a property that has chosen
      // to put live behind the paywall - it is not there by default.
      blackout.dataset.on = 'false';
      if (isPaymentRequired(err)) {
        curtain.fail('');
        void showPaywall('live', () => void tune(ch, mine, relay));
        return;
      }

      curtain.fail(t('toast.channelFail'));
      console.error(err);
    }
  }

  /** Up and down, wrapping, the way every set-top box in the world behaves. */
  function step(delta: number) {
    const i = order.findIndex((c) => c.id === current.id);
    select(order[(i + delta + order.length) % order.length]);
  }

  function toLastChannel() {
    if (!previous) {
      toast(t('player.noLast'));
      return;
    }
    select(previous);
  }

  // ------------------------------------------------------------ number entry

  let digits = '';
  let numberTimer: number | undefined;

  function showNumber(text: string, pending: boolean) {
    numberOsd.textContent = text;
    numberOsd.dataset.on = 'true';
    numberOsd.dataset.pending = String(pending);
  }

  function clearNumber() {
    clearTimeout(numberTimer);
    digits = '';
    numberOsd.dataset.on = 'false';
  }

  function pushDigit(d: string) {
    digits = (digits + d).slice(0, NUMBER_MAX_DIGITS);
    showNumber(digits, true);
    clearTimeout(numberTimer);
    numberTimer = window.setTimeout(commitNumber, NUMBER_COMMIT_MS);
  }

  /**
   * Tune whatever the digits spell, or say plainly that nothing does.
   *
   * The failure matters as much as the success: a guest who types 431 on a
   * property with 200 channels needs to be told that, not left watching the
   * number fade away while nothing happens.
   */
  function commitNumber() {
    clearTimeout(numberTimer);
    const wanted = Number(digits);
    digits = '';
    if (!wanted) {
      numberOsd.dataset.on = 'false';
      return;
    }
    const found = order.find((c) => Number(c.num) === wanted);
    if (!found) {
      showNumber(t('player.noChannel', { n: wanted }), false);
      numberTimer = window.setTimeout(() => (numberOsd.dataset.on = 'false'), 1600);
      return;
    }
    numberOsd.dataset.on = 'false';
    select(found);
  }

  // ---------------------------------------------------------------- overlay

  function showOverlay() {
    const wasHidden = overlay.dataset.hidden === 'true';
    overlay.dataset.hidden = 'false';

    // Coming back from hidden, focus has usually fallen through to <body>.
    // Put it back on a real control or the next remote press does nothing.
    // Deferred, so a caller that is about to focus something itself (opening
    // the zapper, say) wins instead of having focus yanked back here.
    if (wasHidden) {
      queueMicrotask(() => {
        const a = document.activeElement as HTMLElement | null;
        const stillValid =
          a?.classList.contains('focusable') &&
          !a.closest('[data-hidden="true"], [aria-hidden="true"]');
        if (!stillValid) focusFirst(overlay);
      });
    }

    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (zapper.dataset.open !== 'true') overlay.dataset.hidden = 'true';
    }, 6000);
  }

  const root = h(
    'div',
    { class: 'player screen', 'data-skin': opts.skin ?? 'portal' },
    video, blackout, curtain.el, diag, overlay, numberOsd, zapper,
  );

  /**
   * Remote keys the browser reports under several names.
   *
   * Android TV boxes and the MAG-style remotes these properties actually ship
   * send channel up/down as their own keys, and cheaper ones send page up/down
   * instead. All of them mean the same thing to the person holding it.
   */
  const CHANNEL_UP = new Set(['ChannelUp', 'PageUp', 'MediaTrackNext']);
  const CHANNEL_DOWN = new Set(['ChannelDown', 'PageDown', 'MediaTrackPrevious']);

  /**
   * The remote is listened for on the document, in the capture phase, not on
   * this view's own root.
   *
   * Two reasons, both found the hard way. A listener on the root only hears a
   * key when focus is somewhere inside it, and focus does fall out - a stray
   * press on the picture, an element replaced underneath it, a curtain button
   * that disappears when the stream recovers - after which the box stops
   * answering the remote altogether: no zapping, no numbers, not even the
   * overlay coming back. A television does not have that failure mode, and
   * neither should this.
   *
   * Capture, because the D-pad navigator listens on the document too and
   * registered first. In the bubble phase it would move focus before this ever
   * ran; from capture, this decides first and only passes a key on - to the
   * channel list, say - when it has no use for it itself.
   */
  function onKeyDown(e: KeyboardEvent) {
    /*
     * 上面盖着东西的时候，遥控器归它。
     *
     * 模板 B 的菜单、语言选择、付费弹层都是浮在播放画面之上的（底下的台还在播，
     * 这正是它们的意思）。播放器的按键处理挂在 document 上而且是捕获阶段，
     * 不让它先退出来的话，客人在菜单里按上下是在换台，而不是在选菜单项。
     *
     * 认的是 `data-modal`，不是某个具体的类名 —— 以后再加别的浮层，
     * 加一个属性就行，不用回来改播放器。
     */
    if (document.querySelector('[data-modal="true"]')) return;

    const ev = e;
    const k = ev.key;
    const zapperOpen = zapper.dataset.open === 'true';
    const wasHidden = overlay.dataset.hidden === 'true';

    // Digits are the one thing that works with the overlay closed and no
    // focus anywhere useful - which is exactly the state a television spends
    // most of its time in.
    if (!zapperOpen && /^[0-9]$/.test(k)) {
      ev.preventDefault();
      ev.stopPropagation();
      showOverlay();
      pushDigit(k);
      return;
    }

    /*
     * i = info。带 USB 键盘调试时用；房间里的遥控器没有这个键，
     * 上门排查靠后台整店打开（见 homeConfig 的 diagnostics）。
     */
    if (k === 'i' || k === 'I') {
      ev.preventDefault();
      ev.stopPropagation();
      toggleDiag();
      return;
    }

    if (digits && (k === 'Enter' || k === 'NumpadEnter')) {
      ev.preventDefault();
      ev.stopPropagation();
      commitNumber();
      return;
    }

    showOverlay();

    if (!zapperOpen && (CHANNEL_UP.has(k) || CHANNEL_DOWN.has(k))) {
      ev.preventDefault();
      ev.stopPropagation();
      step(CHANNEL_UP.has(k) ? -1 : 1);
      return;
    }

    // Up/Down zap channels the way a TV remote is expected to behave.
    if ((k === 'ArrowUp' || k === 'ArrowDown') && !zapperOpen) {
      ev.preventDefault();
      ev.stopPropagation();
      step(k === 'ArrowDown' ? 1 : -1);
      return;
    }

    /*
     * OK with the overlay already faded out only brings it back.
     *
     * The controls keep focus while they are invisible - they are transparent,
     * not removed - so without this the first press of OK fires whichever
     * button happened to hold focus. A guest who last used Back and then
     * pressed OK to see what was on would find themselves thrown out of the
     * channel entirely.
     */
    if (wasHidden && !zapperOpen && (k === 'Enter' || k === 'NumpadEnter')) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  document.addEventListener('keydown', onKeyDown, true);

  onBack(() => {
    if (digits) {
      clearNumber();
      return true;
    }
    if (zapper.dataset.open === 'true') {
      toggleZapper(false);
      return true;
    }
    onExit();
    return true;
  });

  root.addEventListener('remove-hook', () => {
    document.removeEventListener('keydown', onKeyDown, true);
    clearTimeout(zapTimer);
    clearTimeout(hideTimer);
    clearTimeout(numberTimer);
    playback.destroy();
  });

  renderZapper();
  select(current);
  showOverlay();
  queueMicrotask(() => focusFirst(overlay));

  return root;
}
