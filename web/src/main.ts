import './styles.css';
import {
  api,
  adultUnlocked,
  deviceId,
  type Branding,
  type Category,
  type Channel,
  type HomeConfig,
  type Session,
  type Spot,
  type VodDetail,
  type VodItem,
  type TvTemplate,
} from './api';
import { h, tint, rupiah, toast, clock } from './ui';
import { createPlayback, setDefaultLiveProfile, setDiagnostics } from './hls';
import { showPayment } from './paywall';
import { searchView } from './search';
import { initNav, focusFirst, onBack, grabBack } from './nav';
import { startUpdater } from './updater';
import { t, lang, setLang, LANGS, LANG_NAMES, pick, type Lang } from './i18n';
import { playerView } from './player';
import { detailView, posterCard, vodPlayerView } from './vod';
import { launcherView, type Tile } from './home';
import { openLiveMenu, type MenuEntry } from './livefirst';

const app = document.getElementById('app')!;

let session: Session | null = null;
let channels: Channel[] = [];
let categories: Category[] = [];
let vodItems: VodItem[] = [];
let vodCategories: Category[] = [];

/** Whether this room may show the restricted section at all. Server's call. */
let adultAvailable = false;

/** 这家酒店填了周边内容没有。同样是服务端说了算。 */
let exploreAvailable = false;

/*
 * 片库到了没有。
 *
 * **首页不等它。** 这一条接口要把面板上的电影、剧集和两套分类都拉回来，
 * 九百多条，实测两秒上下；开机时等它等于让客人对着一块黑屏多待两秒，
 * 而首页上有五格跟片库毫无关系。所以开机只是把它踢出去跑，
 * 点播那一格自己负责「还没到」这件事。
 */
let vodReady = false;
let vodPending: Promise<void> | null = null;

function loadVod(): Promise<void> {
  vodPending ??= api
    .vod()
    .then((vod) => {
      vodItems = vod.items;
      vodCategories = vod.categories;
    })
    .catch((err) => {
      // 失败也算「到了」：点进去看到的是「暂无影片」，不是一个永远转下去的圈。
      // 下次开机、或者解锁成人区时会再取一次。
      console.error(err);
    })
    .finally(() => {
      vodReady = true;
      vodPending = null;
    });
  return vodPending;
}

/**
 * 这家酒店用哪一套电视界面，后台定的（见 bff/src/settings.js）。
 *
 * 默认 portal：已经在用的酒店不会因为多了一套模板就变样。
 */
let template: TvTemplate = 'portal';

let propertyName = 'KDTV';
let supportContact = '';
let branding: Branding | null = null;

// Switching language rebuilds whichever screen carries the topbar, so the
// choice takes effect without a reload losing the viewer's place.
let rerender: () => void = () => showHome();

initNav();

/*
 * 界面更新了就自己换上（只在没人用的时候）。
 * 不加这一句的话，部署完墙上那台电视还是旧界面，
 * 要等它下次断电重启 —— 实测踩过。
 */
startUpdater();

// ------------------------------------------------------------------ shell

/**
 * The screen currently on show, kept only so it can be told when it goes.
 *
 * Screens register their own teardown as a `remove-hook` listener on their
 * root - a clock interval, an hls.js instance, a background video holding one
 * of the box's two hardware decoders. Nothing used to dispatch that event, so
 * none of it ever ran: every trip through the launcher left another timer
 * behind, and every channel left its decoder and its downloader running. On a
 * 1GB box that is not a slow leak, it is the difference between a launcher
 * that plays its background and one that has run out of decoders to play it
 * with.
 */
let current: HTMLElement | null = null;

function mount(view: HTMLElement) {
  current?.dispatchEvent(new Event('remove-hook'));
  current = view;
  app.replaceChildren(view);
  // Whatever screen boot ends on - the launcher, the pairing code, a failure -
  // is the moment the boot screen has done its job.
  dismissSplash();
  queueMicrotask(() => focusFirst(view));
}

/**
 * Header for the screens one level below the launcher.
 *
 * The launcher carries the property's own bar; down here a viewer needs to
 * know where they are and how to get back, and nothing else.
 */
function subHeader(title: string) {
  return h(
    'header',
    { class: 'topbar' },
    h('button', {
      class: 'back-btn focusable',
      text: '‹',
      'aria-label': t('player.back'),
      onclick: showHome,
    }),
    h('h1', { class: 'section-title', text: title }),
    h(
      'div',
      { class: 'topbar-right' },
      session?.room?.id ? h('span', { class: 'pill', text: `${t('home.room')} ${session.room.id}` }) : null,
      h('button', { class: 'pill lang focusable', text: LANG_NAMES[lang()], onclick: showLangPicker }),
      h('span', { class: 'pill', text: clock() }),
    ),
  );
}

/** The runner-up language for a menu item, so both sides of a counter can read it. */
function secondName(names: Partial<Record<Lang, string | null>>): string {
  const primary = pick(names);
  const order: Lang[] = lang() === 'zh' ? ['en', 'id'] : ['zh', 'en'];
  for (const l of order) {
    const v = names[l];
    if (v && v !== primary) return v;
  }
  return '';
}

/** Language chooser. A remote has no menu bar, so it is a focusable overlay. */
function showLangPicker() {
  const sheet = h(
    'div',
    { class: 'sheet' },
    h('h2', { text: t('lang.title') }),
    h(
      'div',
      { class: 'sheet-options' },
      ...LANGS.map((l) =>
        h('button', {
          class: 'btn focusable' + (l === lang() ? '' : ' ghost'),
          'data-autofocus': l === lang() ? '' : undefined,
          text: LANG_NAMES[l],
          onclick: () => {
            setLang(l);
            backdrop.remove();
            release();
            rerender();
          },
        }),
      ),
    ),
  );
  const backdrop = h('div', { class: 'backdrop', 'data-modal': 'true' }, sheet);

  /*
   * 关掉的时候把返回键**还给下面那一屏**，而不是设成「什么都不做」。
   *
   * 原来这里写的是 onBack(() => false)，在模板 A 下看不出问题 —— 首页的返回键
   * 本来就什么都不做。到了模板 B，语言选择是浮在播放器上的，这么一写
   * 客人关掉它之后，播放器的返回键（退数字输入、关频道列表）就全失灵了。
   */
  const close = () => {
    backdrop.remove();
    release();
    focusFirst(app);
  };
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  const release = grabBack(() => {
    close();
    return true;
  });

  app.append(backdrop);
  queueMicrotask(() => focusFirst(sheet));
}

// ------------------------------------------------------------------- boot

/**
 * Retire the boot screen.
 *
 * It is removed rather than just hidden - it sits above everything at z-index
 * 9999, and a box that somehow left it in the tree would swallow every
 * keypress the remote sends.
 */
function dismissSplash() {
  const splash = document.getElementById('splash');
  if (!splash || splash.dataset.done === 'true') return;
  splash.dataset.done = 'true';
  window.setTimeout(() => splash.remove(), 600);
}

/**
 * Remember this property's boot dressing for next launch.
 *
 * The splash has to paint before anything is fetched, so it can only ever
 * show what the previous launch left behind. Writing it here is what makes
 * every subsequent boot look right.
 */
/**
 * The property's own photo, kept for the screens behind the launcher.
 *
 * A list of posters on flat black reads like a file manager. The operator has
 * already chosen a picture that says where the guest is, so the same one is
 * reused - blurred far enough down that it is scenery rather than content.
 * A configured video contributes its poster frame: a second decoder on a box
 * with one or two of them is not worth a background.
 */
let sceneryUrl: string | null = null;
let scenes: { live: string | null; vod: string | null; service: string | null } | null = null;

/** The same picture, but filling a box rather than a screen. */
function sceneArt(screen: 'live' | 'vod' | 'service'): HTMLElement | null {
  const url = scenes?.[screen] || sceneryUrl;
  if (!url) return null;
  const el = h('div', { class: 'hero-art' });
  el.style.backgroundImage = `url("${url}")`;
  return el;
}

function scenery(screen: 'live' | 'vod' | 'service'): HTMLElement | null {
  const url = scenes?.[screen] || sceneryUrl;
  if (!url) return null;
  const el = h('div', { class: 'screen-photo' });
  el.style.setProperty('--bg-photo', `url("${url}")`);
  return el;
}

function cacheSplash(cfg: HomeConfig) {
  try {
    localStorage.setItem(
      'wewatch.splash',
      JSON.stringify({
        photo: cfg.branding?.splashUrl ?? cfg.background?.url ?? null,
        logo: cfg.branding?.logoUrl ?? null,
        name: cfg.propertyName ?? null,
      }),
    );
  } catch {
    /* storage unavailable; the box just shows the gradient next time */
  }
}

/** 真的连不上了，才把错误和重试按钮摆给人看。 */
function bootFailed(err: Error) {
  mount(
    h(
      'div',
      { class: 'screen' },
      h(
        'div',
        { class: 'centre' },
        h(
          'div',
          {},
          h('h1', { text: t('boot.failed') }),
          h('p', { class: 'muted', text: String(err.message) }),
          h('button', { class: 'btn focusable', 'data-autofocus': '', text: t('boot.retry'), onclick: boot }),
        ),
      ),
    ),
  );
}

async function boot() {
  // On first launch the boot screen in index.html is already covering this
  // wait, and replacing it with a second spinner would only add a flicker.
  // A retry, arriving after that screen is gone, still needs one.
  if (!document.getElementById('splash')) {
    mount(
      h(
        'div',
        { class: 'screen' },
        h(
          'div',
          { class: 'centre' },
          h('div', {}, h('div', { class: 'spinner' }), h('p', { class: 'muted', text: t('boot.connecting') })),
        ),
      ),
    );
  }

  /*
   * 开机的头半分钟，网络多半还没通。
   *
   * 电视通电之后，我们这个应用（作为桌面或者被开机广播拉起来）常常比 Wi-Fi
   * 关联、比网线协商 DHCP 更早跑起来。第一次 hello 失败几乎是必然的，
   * 而立刻甩一张「连接失败 / 重试」给刚进门的客人，是把一个会自己好的问题
   * 变成了一次投诉。
   *
   * 所以先自己退避重试一分钟左右，期间屏幕上还是那个转圈 —— 从客人的角度
   * 看就是「电视在开机」。**一分钟还不通才是真的有问题**，那时候才值得把
   * 错误和重试按钮摆出来给人看。
   */
  const BOOT_RETRIES = [1000, 2000, 4000, 8000, 15000, 15000, 15000];

  try {
    session = await api.hello();
  } catch (first) {
    let last = first;
    for (const wait of BOOT_RETRIES) {
      await new Promise((r) => setTimeout(r, wait));
      try {
        session = await api.hello();
        last = null;
        break;
      } catch (err) {
        last = err;
      }
    }
    if (last) return bootFailed(last as Error);
  }

  if (!session) return bootFailed(new Error(t('boot.failed')));

  // Not yet paired: show the code an operator types into the portal. The
  // guest is never asked for a server address, only this number exists.
  if (!session.activated) {
    return mount(
      h(
        'div',
        { class: 'screen' },
        h(
          'div',
          { class: 'centre' },
          h(
            'div',
            {},
            h('div', { class: 'kicker' }, h('span', { class: 'dot' }), t('activate.kicker')),
            h('h1', { style: 'margin:.75rem 0', text: t('activate.title') }),
            h('div', { class: 'code', text: session.pairingCode ?? '------' }),
            h('p', { class: 'muted', text: t('activate.hint') }),
            h('button', { class: 'btn focusable', 'data-autofocus': '', text: t('activate.refresh'), onclick: boot }),
          ),
        ),
      ),
    );
  }

  adultAvailable = Boolean(session.adultAvailable);
  exploreAvailable = Boolean(session.exploreAvailable);

  try {
    const data = await api.channels();
    channels = data.channels;
    categories = data.categories;
  } catch (err) {
    toast(t('toast.channelFail'));
    console.error(err);
  }

  // Property dressing is cosmetic; never let it hold up the launcher.
  try {
    const cfg = await api.homeConfig();
    propertyName = cfg.propertyName || propertyName;
    supportContact = cfg.supportContact || '';
    branding = cfg.branding ?? null;
    sceneryUrl =
      (cfg.background?.type === 'image' ? cfg.background.url : cfg.background?.poster) ??
      cfg.branding?.splashUrl ??
      null;
    scenes = cfg.scenes ?? null;
    // 后台给的是默认档；这台盒子自己改过的话 liveProfile() 里以它自己的为准。
    template = cfg.tv?.template === 'live' ? 'live' : 'portal';
    setDefaultLiveProfile(cfg.tv?.liveProfile);
    setDiagnostics(Boolean(cfg.tv?.diagnostics));
    cacheSplash(cfg);
  } catch (err) {
    console.error(err);
  }

  // 片库在后台取，不挡首页 —— 见 loadVod()。
  void loadVod();

  showHome();
}

// --------------------------------------------------------------- launcher

/**
 * 「回到这家酒店的首页」。
 *
 * 两套模板的首页是两回事：模板 A 回宫格，模板 B 回直播全屏 —— 因为模板 B
 * **没有首页**，开机就在播放器里。所有「退出到首页」的地方都走这一个入口，
 * 而不是各自判断模板：漏掉一处，客人就会在某个屏幕上按返回掉进另一套界面。
 */
function showHome() {
  return template === 'live' ? showLiveFirst() : showPortalHome();
}

function showPortalHome() {
  onBack(() => false);
  rerender = showHome;

  /*
   * 传的是 i18n 的 key，不是译好的字。
   *
   * 每格要摆两行 —— 上面英文、下面客人选的语言 —— 译好的字只剩一种语言，
   * 另一行就没处来了。key 交给 home.ts，它自己取两次。
   */
  const tiles: Tile[] = [
    { id: 'live', icon: 'tv', key: 'tile.live', go: showLive },
    { id: 'vod', icon: 'film', key: 'tile.vod', go: showVod },
    { id: 'service', icon: 'grid', key: 'tile.service', go: showService },
    { id: 'about', icon: 'building', key: 'tile.about', go: showAbout },
  ];

  // 填了周边内容才摆这一格。空的比没有更难看。
  if (exploreAvailable) {
    tiles.push({ id: 'explore', icon: 'map', key: 'tile.explore', go: showExplore });
  }

  // Last, and only where it is allowed. A room that is not entitled never
  // learns the tile exists, because the server never told this box about it.
  if (adultAvailable) {
    tiles.push({ id: 'adult', icon: 'lock', key: 'tile.adult', go: enterAdult });
  }

  const root = launcherView(session, tiles, showLangPicker);
  mount(root);

  /*
   * 回到首页时悄悄再问一次服务端。
   *
   * 「这个房间能不能看成人区」「这家酒店填周边了没有」「客人叫什么名字」——
   * 这几件事**只在开机那一次 hello 里发过一次**。前台在后台勾完，电视上要
   * 等到下次开机才认，而前台看到的是「我勾了，它没反应」，然后去拔电源。
   *
   * 所以每次回到首页问一次（一个很小的请求），**只有真的变了才重画** ——
   * 无条件重画会把焦点弹回第一格，客人按着遥控器的手会觉得屏幕在跟他抢。
   */
  const before = JSON.stringify([adultAvailable, exploreAvailable, session?.room?.id ?? null]);
  void api
    .hello()
    .then((fresh) => {
      if (!fresh.activated) return;
      session = fresh;
      adultAvailable = Boolean(fresh.adultAvailable);
      exploreAvailable = Boolean(fresh.exploreAvailable);
      const after = JSON.stringify([adultAvailable, exploreAvailable, session?.room?.id ?? null]);
      // 人已经点进别的屏幕了就不管 —— 往一个扔掉的首页上重画没有意义。
      if (after !== before && root.isConnected) showPortalHome();
    })
    .catch(() => {
      /* 问不到就算了，首页上现成的那份照常用 */
    });
}

// ------------------------------------------------- 模板 B：直播优先

/**
 * 关机前在看哪个台。
 *
 * 存在盒子本地而不是服务器上：这是「这台电视」的状态，不是「这个房间」的 ——
 * 换了客人之后，电视停在上一位客人看的台，这是电视本来的样子，
 * 而且不需要为此多一次网络请求，开机路径上每一次请求都是客人在等。
 */
const LAST_CHANNEL_KEY = 'wewatch.lastChannel';

function rememberChannel(ch: Channel) {
  liveNow = ch;
  try {
    localStorage.setItem(LAST_CHANNEL_KEY, String(ch.id));
  } catch {
    /* 存储不可用（隐私模式、盒子存储满）就只在这次开机内有效 */
  }
}

function rememberedChannel(list: Channel[]): Channel | null {
  try {
    const id = Number(localStorage.getItem(LAST_CHANNEL_KEY));
    return list.find((c) => c.id === id) ?? null;
  } catch {
    return null;
  }
}

/** 菜单标题要显示的「正在播放」。 */
let liveNow: Channel | null = null;

/**
 * 模板 B 的首页：直接就是直播全屏。
 *
 * 开机落在**上次看的台**上，没有就落在频道号最小的那个。不是随便挑一个 ——
 * 客人昨晚看到一半关的电视，今早打开还是那个台，这是电视应有的样子。
 */
function showLiveFirst() {
  onBack(() => false);
  rerender = showLiveFirst;

  const list = openChannels();

  /*
   * 一个台都没有的时候退回门户。
   *
   * 直播优先的前提是有直播可放；线路没配好、或者整个分类都被限制掉的时候，
   * 客人对着一个黑屏和一句「没有频道」是没有出路的 —— 门户至少还有
   * 客房服务和酒店信息。**模板不该把人锁在一个空房间里。**
   */
  if (!list.length) return showPortalHome();

  const start =
    rememberedChannel(list) ?? [...list].sort((a, b) => (a.num || 0) - (b.num || 0))[0];
  liveNow = start;

  const root = playerView(list, start.id, () => openLiveFirstMenu(root), {
    skin: 'live',
    exitLabel: t('player.menu'),
    onTune: rememberChannel,
  });

  mount(root);
}

/** 浮在直播画面上的菜单。底下的台不停。 */
function openLiveFirstMenu(host: HTMLElement) {
  const entries: MenuEntry[] = [];

  // 片库是空的就不摆这一格 —— 点进去是空屏，不如没有。
  // **还没取回来的时候当它有**：这会儿藏起来，两秒后它又冒出来，更奇怪。
  if (!vodReady || vodItems.some((i) => !i.adult)) {
    entries.push({ id: 'vod', icon: 'film', label: t('tile.vod'), go: showVod });
  }
  entries.push({ id: 'service', icon: 'grid', label: t('tile.service'), go: showService });
  entries.push({ id: 'about', icon: 'building', label: t('tile.about'), go: showAbout });
  if (exploreAvailable) {
    entries.push({ id: 'explore', icon: 'map', label: t('tile.explore'), go: showExplore });
  }
  if (adultAvailable) {
    entries.push({ id: 'adult', icon: 'lock', label: t('tile.adult'), go: enterAdult });
  }
  entries.push({ id: 'lang', icon: 'star', label: LANG_NAMES[lang()], go: showLangPicker });

  openLiveMenu(host, entries, liveNow?.name ?? '');
}

function showAbout() {
  onBack(() => {
    showHome();
    return true;
  });
  rerender = showAbout;

  const rows: [string, string][] = [
    [t('about.room'), session?.room?.id ?? t('home.noRoom')],
    [t('about.device'), deviceId()],
    [
      t('about.line'),
      session?.profile?.status === 'Active' ? t('about.active') : t('about.inactive'),
    ],
    [t('about.version'), session?.appVersion ?? '-'],
  ];

  const body = h(
    'div',
    { class: 'body' },
    h(
      'section',
      { class: 'about' },
      // The property's own mark when it has uploaded one; its name otherwise.
      branding?.logoUrl
        ? h('img', { class: 'about-logo', src: branding.logoUrl, alt: propertyName })
        : null,
      h('h2', { class: 'about-name', text: propertyName }),
      h(
        'dl',
        { class: 'about-rows' },
        ...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]),
      ),
      supportContact
        ? h(
            'p',
            { class: 'about-support' },
            h('span', { class: 'muted', text: `${t('about.support')}: ` }),
            h('strong', { text: supportContact }),
          )
        : null,
      h('button', { class: 'btn focusable', 'data-autofocus': '', text: t('player.back'), onclick: showHome }),
    ),
  );

  mount(h('div', { class: 'screen' }, subHeader(t('tile.about')), body));
}

// ------------------------------------------------------------------- home

/*
 * 焦点停在一张卡上超过这么久，才去要预览图。
 *
 * 遥控器按住方向键是会连划过去十几张的，每划过一张就发一个请求等于让服务器
 * 替一个根本没在看的频道去拉流。停下来才算「在看这一张」。
 */
const PREVIEW_DWELL_MS = 450;

function channelCard(ch: Channel, go: (ch: Channel) => void = (c) => showPlayer(c.id)) {
  const t = tint(ch.name);
  const shot = h('img', { class: 'card-shot', alt: '', 'aria-hidden': 'true' }) as HTMLImageElement;
  let timer: number | undefined;

  /*
   * 静图当卡片底图，不管有没有焦点 —— 客人扫一眼整屏就知道各台在放什么。
   * 会动的那张只给当前这一张（见下面的 focus）：91 张同时解动图，盒子会跪。
   */
  const poster = ch.poster
    ? (h('img', {
        class: 'card-poster',
        src: ch.poster,
        alt: '',
        'aria-hidden': 'true',
        loading: 'lazy',
      }) as HTMLImageElement)
    : null;

  const card = h(
    'button',
    { class: 'card focusable', onclick: () => go(ch) },
    h(
      'div',
      { class: 'card-art', style: `--c1:${t.c1};--c2:${t.c2}` },
      h('span', { class: 'card-num', text: String(ch.num) }),
      ch.icon ? h('img', { src: ch.icon, alt: '', loading: 'lazy' }) : h('span', { class: 'card-initial', text: t.initial }),
      poster,
      shot,
    ),
    h(
      'div',
      { class: 'card-meta' },
      h('div', { class: 'card-title', text: ch.name }),
      h('div', { class: 'card-sub', text: ch.categoryName }),
    ),
  );

  /*
   * 只有**当前这一张**挂着图。
   *
   * 91 张卡同时挂 91 张动图，浏览器会认认真真地把它们全解出来 —— 盒子会卡。
   * 焦点一走就把 src 摘掉，解码随之停下。
   */
  card.addEventListener('focus', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      /*
       * 第一次问一个从没抓过的频道，服务端只会**开始抓**然后回个空 ——
       * 图要两三秒后才有。只问一次的话，第一次停在这张卡上永远是空的，
       * 得离开再回来才看得到，像坏的。所以停在这里就多问几次。
       */
      for (let tries = 0; tries < 4; tries++) {
        if (document.activeElement !== card) return;
        try {
          const r = await api.preview(ch.id);
          if (document.activeElement !== card) return;
          // 整店关了，或者这是受限频道 —— 再问多少次都不会有。
          if (r.off || r.restricted) return;
          if (r.url) {
            shot.onload = () => card.classList.add('has-shot');
            shot.src = r.url;
            return;
          }
        } catch {
          return; /* 网络不行就算了，卡片还是原来那张纯色的 */
        }
        await new Promise((done) => window.setTimeout(done, 2500));
      }
    }, PREVIEW_DWELL_MS);
  });

  card.addEventListener('blur', () => {
    window.clearTimeout(timer);
    card.classList.remove('has-shot');
    shot.removeAttribute('src');
  });

  return card;
}

function rail(titleText: string, items: Channel[], note?: string, go?: (ch: Channel) => void) {
  return h(
    'section',
    { class: 'rail' },
    h(
      'div',
      { class: 'rail-head' },
      h('h2', { text: titleText }),
      note ? h('span', { text: note }) : null,
    ),
    h('div', { class: 'rail-track' }, ...items.map((ch) => channelCard(ch, go))),
  );
}

/*
 * The ordinary screens see the ordinary catalogue.
 *
 * Once a PIN has been entered the restricted items are in `channels` and
 * `vodItems` like anything else, and they must not leak back into the normal
 * shelves - or into the zapper, where holding Down would walk a guest straight
 * into them. Everything below the launcher filters, and only the restricted
 * section itself asks for the other half.
 */
const openChannels = () => channels.filter((c) => !c.adult);
const openCategories = () => categories.filter((c) => !c.adult);

function showLive() {
  // This screen used to be the home screen, where Back meant nothing. It sits
  // under the launcher now, so Back has to climb back out of it.
  onBack(() => {
    showHome();
    return true;
  });

  const list = openChannels();
  const featured = list[0];
  const body = h('div', { class: 'body' });

  const preview = featured
    ? (h('video', {
        class: 'hero-video',
        muted: '',
        autoplay: '',
        playsinline: '',
        'aria-hidden': 'true',
      }) as HTMLVideoElement)
    : null;
  // A script-created element ignores the `muted` attribute - it sets the
  // default, not the property - and an unmuted preview would talk over the
  // room.
  if (preview) preview.muted = true;

  if (featured) {
    body.append(
      h(
        'section',
        { class: 'hero' },
        preview,
        h(
          'div',
          { class: 'hero-inner' },
          h('div', { class: 'kicker' }, h('span', { class: 'dot' }), t('home.onNow')),
          h('h1', { text: featured.name }),
          h('p', { text: t('home.summary', { n: channels.length, c: categories.length }) }),
          h(
            'div',
            { class: 'hero-actions' },
            h('button', {
              class: 'btn focusable',
              'data-autofocus': '',
              text: t('home.watch'),
              onclick: () => showPlayer(featured.id),
            }),
            vodItems.length
              ? h('button', { class: 'btn ghost focusable', text: t('tile.vod'), onclick: showVod })
              : null,
            h('button', { class: 'btn ghost focusable', text: t('tile.service'), onclick: showService }),
          ),
        ),
      ),
    );
  }

  for (const cat of openCategories()) {
    const items = list.filter((c) => c.categoryId === cat.id);
    if (items.length) body.append(rail(cat.name, items, t('home.channels', { n: items.length })));
  }

  if (!list.length) {
    body.append(
      h('div', { class: 'centre' }, h('p', { class: 'muted', text: t('home.empty') })),
    );
  }

  rerender = showLive;
  const screen = h('div', { class: 'screen live' }, scenery('live'), subHeader(t('tile.live')), body);

  /*
   * The hero shows the channel it is naming, not a gradient.
   *
   * It is the same stream the OK button would open, muted and behind the
   * text - which is what a television does, and what makes the box feel like
   * one. Three things keep it honest on weak hardware:
   *
   *   - it starts late (900ms), so running past this screen on the way
   *     somewhere else never opens a stream at all;
   *   - it is torn down on `remove-hook`, including when the viewer presses
   *     OK, so the decoder is free before the full player asks for one;
   *   - it fails silently. This is decoration: a channel that will not open
   *     here leaves the panel's own gradient and says nothing, because the
   *     viewer has not asked for it yet.
   */
  if (featured && preview) {
    let playback: ReturnType<typeof createPlayback> | null = null;
    const timer = window.setTimeout(async () => {
      try {
        const { url } = await api.play(featured.id);
        if (!preview.isConnected) return;
        playback = createPlayback(preview);
        await playback.load(url, 'live');
        preview.dataset.on = '';
      } catch {
        /* decoration that did not arrive is not a failure */
      }
    }, 900);

    screen.addEventListener('remove-hook', () => {
      clearTimeout(timer);
      playback?.destroy();
    });
  }

  mount(screen);
}

// -------------------------------------------------------------------- vod

function showVod() {
  onBack(() => {
    showHome();
    return true;
  });
  rerender = showVod;

  /*
   * 片库还在路上：先把这一屏亮出来。
   *
   * 关键是**按下去立刻换屏**。客人分不清「在加载」和「没按上」，分不清就会
   * 连按 —— 这正是原来那五六秒里发生的事。到了之后自己重画一遍，
   * 除非客人已经走了（screen 不在文档里了就不画，别往一个扔掉的屏幕上画）。
   */
  if (!vodReady) {
    const waiting = h(
      'div',
      { class: 'screen vod' },
      scenery('vod'),
      subHeader(t('tile.vod')),
      h('div', { class: 'body' }, h('div', { class: 'centre' }, h('p', { class: 'muted', text: t('vod.loading') }))),
    );
    mount(waiting);
    focusFirst(waiting);
    void loadVod().then(() => {
      if (waiting.isConnected) showVod();
    });
    return;
  }

  const body = h('div', { class: 'body' });

  const openVod = vodItems.filter((i) => !i.adult);

  if (!openVod.length) {
    body.append(
      h(
        'div',
        { class: 'centre' },
        h(
          'div',
          {},
          h('h1', { text: t('vod.emptyTitle') }),
          h('p', { class: 'muted', text: t('vod.emptyBody') }),
          h('button', { class: 'btn focusable', 'data-autofocus': '', text: t('player.back'), onclick: showHome }),
        ),
      ),
    );
  }

  /*
   * 这一页是**先上屏、后填满**的，不是一次铺完。
   *
   * 铺完是九百多张海报、五千多个节点：盒子上按 OK 之后要黑等五六秒才换屏，
   * 客人以为没按上，会连按好几下。而第一屏其实只看得见头两排的七八张。
   *
   * 所以先渲染够铺满第一屏的量，立刻 mount，剩下的在空闲时间一批批补进去。
   * 补的顺序就是排面顺序，客人往下翻的速度永远追不上 —— 而就算追上了，
   * 看到的也只是还没长出来的那一排，不是一块黑屏。
   */
  const FIRST = 2;   // 先铺满这么多排
  const CHUNK = 12;  // 之后每批补几张

  const shelves = vodCategories
    .filter((c) => !c.adult)
    .map((cat) => ({ cat, items: openVod.filter((i) => i.categoryId === cat.id) }))
    .filter((s) => s.items.length);

  const queue: Array<() => void> = [];

  shelves.forEach(({ cat, items }, index) => {
    const track = h('div', { class: 'rail-track posters' });
    body.append(
      h(
        'section',
        { class: 'rail' },
        h(
          'div',
          { class: 'rail-head' },
          h('h2', { text: cat.name }),
          h('span', { text: t('vod.titles', { n: items.length }) }),
        ),
        track,
      ),
    );

    // 头几排先放一批，保证第一眼是满的；再往下的排一张都不先放 ——
    // 它们在屏幕外面，先放只是拖慢上屏。
    const head = index < FIRST ? items.slice(0, CHUNK) : [];
    track.append(...head.map((it) => posterCard(it, showVodDetail)));

    for (let i = head.length; i < items.length; i += CHUNK) {
      const slice = items.slice(i, i + CHUNK);
      queue.push(() => track.append(...slice.map((it) => posterCard(it, showVodDetail))));
    }
  });

  drain(queue);

  const head = subHeader(t('tile.vod'));
  // 搜索入口放在标题栏右边、房间号左边 —— 进点播页第一眼就在，
  // 不用先往下翻过几排海报才发现有搜索。
  head.querySelector('.topbar-right')?.prepend(
    h('button', {
      class: 'pill focusable search-entry',
      text: t('search.entry'),
      onclick: showSearch,
    }),
  );
  mount(h('div', { class: 'screen vod' }, scenery('vod'), head, body));
}

/**
 * 趁空闲把排队的活干掉，一次一批。
 *
 * 用 requestIdleCallback 是因为这台机器上「空闲」是真的稀缺：客人按遥控器
 * 的那一刻必须有反应，补海报的活得给按键让路。没有这个 API 的内核退回
 * setTimeout —— 慢一点，但不会卡住输入。
 *
 * `token` 是用来作废的：客人退出点播页又进来，上一轮还没补完的活就该停了，
 * 不然它还在往一个已经不在文档里的元素上塞节点。
 */
let drainToken = 0;

function drain(queue: Array<() => void>) {
  const token = ++drainToken;
  const idle: (fn: () => void) => void =
    typeof (window as any).requestIdleCallback === 'function'
      ? (fn) => (window as any).requestIdleCallback(fn, { timeout: 500 })
      : (fn) => window.setTimeout(fn, 16);

  let i = 0;
  const step = () => {
    if (token !== drainToken) return;
    const started = Date.now();
    // 一口气干到 12 毫秒为止：再长就会在补图的中间吃掉一次按键。
    while (i < queue.length && Date.now() - started < 12) queue[i++]();
    if (i < queue.length) idle(step);
  };
  idle(step);
}

function showSearch() {
  mount(
    searchView(
      vodItems.filter((i) => !i.adult),
      showVodDetail,
      showVod,
    ),
  );
}

function showVodDetail(item: VodItem) {
  mount(detailView(item, showVodPlayer, showVod));
}

function showVodPlayer(detail: VodDetail, episodeIndex: number) {
  mount(vodPlayerView(detail, episodeIndex, () => showVodDetail({
    id: detail.id,
    kind: detail.kind,
    name: detail.name,
    icon: detail.cover,
    year: detail.year,
    rating: detail.rating,
    categoryId: '',
    categoryName: '',
    container: detail.container ?? null,
  })));
}

// ----------------------------------------------------------------- player

function showPlayer(streamId: number, list: Channel[] = openChannels(), back: () => void = showLive) {
  mount(playerView(list, streamId, back));
}

// -------------------------------------------------------------- restricted

/**
 * The restricted section.
 *
 * Three separate things keep it shut, and only the last one is on this side of
 * the wire: the property has to carry it, the room has to be allowed it, and
 * whoever is holding the remote has to know the PIN. The television app is
 * told nothing about any of it until the server says so, and the content
 * itself is filtered and guarded server-side - so what follows is a door, not
 * a curtain over an open doorway.
 */
async function enterAdult() {
  // Ask the server rather than trusting the local flag: an unlock is a
  // half-hour window, and one that quietly expired would otherwise open an
  // empty section instead of asking for the PIN again.
  try {
    const st = await api.adultStatus();
    if (!st.available) {
      adultAvailable = false;
      toast(t('adult.unavailable'));
      showHome();
      return;
    }
    if (st.unlocked && adultUnlocked()) {
      showAdultSection();
      return;
    }
  } catch (err) {
    console.error(err);
  }
  askPin();
}

/**
 * Re-fetch both catalogues, because what they contain depends on the lock.
 *
 * Each is caught separately: a property with live channels and no films should
 * still get its channels, and locking must never be the thing that fails.
 */
async function reloadCatalogue() {
  try {
    const live = await api.channels();
    channels = live.channels;
    categories = live.categories;
  } catch (err) {
    console.error(err);
  }
  // 解锁之后片库的内容不一样了，必须重新取 —— 把记忆化那份作废。
  vodPending = null;
  vodReady = false;
  await loadVod();
}

/**
 * PIN entry, built for a remote.
 *
 * An on-screen keypad rather than a text field, because a set-top box has no
 * keyboard and the D-pad has to be able to reach every digit. Physical number
 * keys work too - the remotes these properties ship have them, and someone who
 * knows the PIN would rather just type it.
 */
function askPin() {
  let pin = '';
  const dots = h('div', { class: 'pin-dots' });
  const msg = h('p', { class: 'muted pin-msg', text: t('adult.enterPin') });
  let busy = false;

  function paint() {
    dots.replaceChildren(
      ...Array.from({ length: Math.max(4, pin.length) }, (_, i) =>
        h('i', { class: i < pin.length ? 'on' : '' }),
      ),
    );
  }

  function push(d: string) {
    if (busy || pin.length >= 8) return;
    pin += d;
    paint();
  }

  function back() {
    if (busy) return;
    pin = pin.slice(0, -1);
    paint();
  }

  async function submit() {
    if (busy || pin.length < 4) {
      if (!busy) msg.textContent = t('adult.tooShort');
      return;
    }
    busy = true;
    msg.textContent = t('adult.checking');
    const res = await api.adultUnlock(pin);
    busy = false;
    pin = '';
    paint();

    if (res.ok) {
      close();
      await reloadCatalogue();
      showAdultSection();
      return;
    }
    if (res.reason === 'locked') {
      const mins = Math.max(1, Math.ceil(res.retryAfterMs / 60000));
      msg.textContent = t('adult.lockedOut', { n: mins });
      return;
    }
    if (res.reason === 'unavailable') {
      msg.textContent = t('adult.unavailable');
      return;
    }
    msg.textContent =
      res.remaining !== undefined
        ? t('adult.wrongPin', { n: res.remaining })
        : t('adult.wrongPinPlain');
  }

  const keypad = h(
    'div',
    { class: 'pin-pad' },
    ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) =>
      h('button', { class: 'btn focusable pin-key', text: d, onclick: () => push(d) }),
    ),
    h('button', { class: 'btn ghost focusable pin-key', text: '⌫', onclick: back }),
    h('button', { class: 'btn focusable pin-key', text: '0', onclick: () => push('0') }),
    h('button', { class: 'btn focusable pin-key ok', text: 'OK', onclick: () => void submit() }),
  );

  const sheet = h(
    'div',
    { class: 'sheet pin-sheet' },
    h('h2', { text: t('adult.title') }),
    msg,
    dots,
    keypad,
    h('button', {
      class: 'btn ghost focusable',
      style: 'margin-top:1rem',
      text: t('player.back'),
      onclick: () => {
        close();
        showHome();
      },
    }),
  );
  const backdrop = h('div', { class: 'backdrop', 'data-modal': 'true' }, sheet);

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    onBack(() => false);
  }

  /*
   * The physical keys, which is how this is actually used.
   *
   * A guest types four digits on the remote's number pad and presses OK. Left
   * to the browser, OK activates whatever button happens to hold focus - the
   * "1" - so the PIN they just typed silently gains a fifth digit and fails.
   * So OK submits, Back deletes, and the on-screen pad is for the rooms whose
   * remote has no numbers at all.
   */
  function onKey(e: KeyboardEvent) {
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      push(e.key);
      return;
    }
    if ((e.key === 'Enter' || e.key === 'OK') && pin.length >= 4) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      back();
    }
  }

  document.addEventListener('keydown', onKey, true);
  onBack(() => {
    close();
    showHome();
    return true;
  });

  paint();
  app.append(backdrop);
  queueMicrotask(() => focusFirst(sheet));
}

function showAdultSection() {
  const chans = channels.filter((c) => c.adult);
  const films = vodItems.filter((i) => i.adult);

  onBack(() => {
    showHome();
    return true;
  });

  const body = h('div', { class: 'body' });

  body.append(
    h(
      'div',
      { class: 'adult-bar' },
      h('span', { class: 'pill adult', text: '18+' }),
      h('span', { class: 'muted', text: t('adult.notice') }),
      h('button', {
        class: 'btn ghost focusable',
        text: t('adult.lock'),
        onclick: async () => {
          await api.adultLock();
          await reloadCatalogue();
          showHome();
        },
      }),
    ),
  );

  for (const cat of categories.filter((c) => c.adult)) {
    const items = chans.filter((c) => c.categoryId === cat.id);
    if (!items.length) continue;
    body.append(
      // Its own player list, so up/down inside the section stays inside it -
      // and, just as importantly, so zapping in the ordinary player can never
      // wander in here.
      rail(cat.name, items, t('home.channels', { n: items.length }), (ch) =>
        showPlayer(ch.id, chans, showAdultSection),
      ),
    );
  }

  for (const cat of vodCategories.filter((c) => c.adult)) {
    const items = films.filter((i) => i.categoryId === cat.id);
    if (!items.length) continue;
    body.append(
      h(
        'section',
        { class: 'rail' },
        h(
          'div',
          { class: 'rail-head' },
          h('h2', { text: cat.name }),
          h('span', { text: t('vod.titles', { n: items.length }) }),
        ),
        h('div', { class: 'rail-track posters' }, ...items.map((it) => posterCard(it, showVodDetail))),
      ),
    );
  }

  if (!chans.length && !films.length) {
    body.append(h('div', { class: 'centre' }, h('p', { class: 'muted', text: t('adult.empty') })));
  }

  rerender = showAdultSection;
  mount(h('div', { class: 'screen adult' }, subHeader(t('tile.adult')), body));
}

// ---------------------------------------------------------------- service

async function showService() {
  onBack(() => {
    showHome();
    return true;
  });

  const cart = new Map<number, { qty: number; price: number; name: string }>();
  const body = h('div', { class: 'body' });
  const screen = h(
    'div',
    { class: 'screen service' },
    scenery('service'),
    subHeader(t('tile.service')),
    body,
  );
  rerender = showService;
  mount(screen);

  let bar: HTMLElement | null = null;
  function renderCart() {
    bar?.remove();
    if (!cart.size) {
      bar = null;
      return;
    }
    let total = 0;
    let count = 0;
    for (const line of cart.values()) {
      total += line.price * line.qty;
      count += line.qty;
    }
    bar = h(
      'div',
      { class: 'cartbar' },
      h('strong', { text: t('svc.items', { n: count }) }),
      h('span', { class: 'muted', text: rupiah(total) }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost focusable', text: t('svc.clear'), onclick: () => { cart.clear(); refresh(); } }),
      h('button', { class: 'btn focusable', text: t('svc.order'), onclick: submit }),
    );
    screen.append(bar);
  }

  async function submit() {
    try {
      const res = await api.order(
        [...cart.entries()].map(([id, l]) => ({ id, qty: l.qty })),
      );
      cart.clear();
      refresh();

      /*
       * The order is placed either way; payment is the step after it.
       *
       * When the property takes no online payment - or the gateway was down
       * when the order went in - there is simply no code to show, and the
       * guest is told to settle at the front desk. That is the behaviour this
       * had before there was a gateway at all, and it has to survive one
       * being switched off.
       */
      if (res.payment) {
        showPayment(res.payment, { title: t('pay.orderPay', { id: res.orderId }) });
      } else {
        toast(t('svc.ordered', { id: res.orderId, total: rupiah(res.total) }));
      }
    } catch (err) {
      toast(t('svc.orderFail'));
      console.error(err);
    }
  }

  function refresh() {
    for (const el of body.querySelectorAll<HTMLElement>('.svc')) {
      const id = Number(el.dataset.id);
      const line = cart.get(id);
      const q = el.querySelector('.qty');
      if (q) q.innerHTML = line ? `${t('svc.chosen')}: <b>${line.qty}</b>` : '';
    }
    renderCart();
  }

  try {
    const { categories: cats } = await api.menu();
    const { notices } = await api.notices().catch(() => ({ notices: [] as any[] }));

    if (notices.length) {
      body.append(
        h(
          'section',
          { class: 'hero notice' },
          // The property's own picture, behind its own words. A welcome
          // message on a flat panel of colour looks like a system dialog.
          sceneArt('service'),
          h(
            'div',
            { class: 'hero-inner' },
            h('div', { class: 'kicker' }, h('span', { class: 'dot' }), t('svc.info')),
            h('h1', { style: 'font-size:1.6rem', text: notices[0].title }),
            h('p', { text: notices[0].body ?? '' }),
          ),
        ),
      );
    }

    for (const cat of cats) {
      body.append(
        h('div', { class: 'rail-head' }, h('h2', { text: t(`svc.cat.${cat.name}`) })),
        h(
          'div',
          { class: 'grid', style: 'margin-bottom:1.5rem' },
          ...cat.items.map((it) =>
            h(
              'button',
              {
                class: 'svc focusable',
                'data-id': String(it.id),
                onclick: () => {
                  const line = cart.get(it.id);
                  cart.set(it.id, {
                    qty: (line?.qty ?? 0) + 1,
                    price: it.price,
                    name: it.name.en,
                  });
                  refresh();
                },
              },
              h('div', { class: 'svc-name', text: pick(it.name) }),
              // A second line in the box's own language: dormitory staff and
              // residents rarely read the same one.
              secondName(it.name) ? h('div', { class: 'svc-zh', text: secondName(it.name) }) : null,
              h('div', { class: 'svc-price' + (it.price ? '' : ' free'), text: rupiah(it.price) }),
              h('div', { class: 'qty' }),
            ),
          ),
        ),
      );
    }
    focusFirst(screen);
  } catch (err) {
    body.append(h('div', { class: 'centre' }, h('p', { class: 'muted', text: 'Menu tidak tersedia.' })));
    console.error(err);
  }
}

// ------------------------------------------------------------- 旅游周边

/**
 * 酒店周边值得去的地方。一屏大图卡片，点进去看一张图加一段介绍。
 *
 * 做成两层是因为介绍能写到六百字：塞在卡片上谁也读不完，而卡片墙上要的
 * 只是一眼看出那是什么地方。
 */
async function showExplore() {
  onBack(() => {
    showHome();
    return true;
  });
  rerender = showExplore;

  const body = h('div', { class: 'body' });
  const screen = h('div', { class: 'screen' }, subHeader(t('explore.title')), body);
  mount(screen);

  let spots: Spot[] = [];
  try {
    spots = (await api.explore()).spots;
  } catch (err) {
    console.error(err);
  }

  if (!spots.length) {
    // 服务端本来就不该把这一格发下来，走到这里说明内容刚被下架。
    body.append(h('div', { class: 'centre' }, h('p', { class: 'muted', text: t('explore.empty') })));
    focusFirst(screen);
    return;
  }

  body.append(
    h(
      'div',
      { class: 'grid spots' },
      ...spots.map((spot) =>
        h(
          'button',
          { class: 'spot focusable', onclick: () => showSpot(spot) },
          h(
            'span',
            { class: 'spot-art' },
            spot.image ? h('img', { src: spot.image, alt: '', loading: 'lazy' }) : null,
          ),
          h(
            'span',
            { class: 'spot-meta' },
            h('span', { class: 'spot-name', text: pick(spot.name) }),
            secondName(spot.name)
              ? h('span', { class: 'spot-sub', text: secondName(spot.name) })
              : null,
          ),
        ),
      ),
    ),
  );
  focusFirst(screen);
}

/** 一个去处的详情。返回回到卡片墙，不是回首页。 */
function showSpot(spot: Spot) {
  onBack(() => {
    showExplore();
    return true;
  });
  rerender = () => showSpot(spot);

  const desc = pick(spot.desc);
  const screen = h(
    'div',
    { class: 'screen' },
    // 顶栏还是「旅游周边」：它是面包屑，说明按左上角回到哪里去。
    // 地名在下面写成大字，顶栏再写一遍只是重复。
    subHeader(t('explore.title')),
    h(
      'div',
      { class: 'body spot-page' },
      spot.image ? h('img', { class: 'spot-hero', src: spot.image, alt: '' }) : null,
      h('h2', { class: 'spot-title', text: pick(spot.name) }),
      secondName(spot.name) ? h('p', { class: 'spot-sub', text: secondName(spot.name) }) : null,
      // pre-wrap：前台是按行敲的地址和营业时间，挤成一段就没法看了。
      desc ? h('p', { class: 'spot-body', text: desc }) : null,
      h('button', {
        class: 'btn focusable',
        'data-autofocus': '',
        text: t('player.back'),
        onclick: showExplore,
      }),
    ),
  );
  mount(screen);
  focusFirst(screen);
}

boot();
