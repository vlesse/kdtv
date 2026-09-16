import type HlsType from 'hls.js';
import { t } from './i18n';

/**
 * One place that knows how to put a stream on a <video>, and how to keep it
 * there.
 *
 * Which engine plays a stream is decided here, and the answer changed once a
 * real box was watched doing it. Chromium grew its own HLS demuxer on Android
 * (WebView 125+), so a box now answers "maybe" to `canPlayType` and used to be
 * handed the stream on that basis. It cannot play these: every URL the panel
 * mints is a 302 onto a CDN, and the built-in demuxer dies on the first
 * manifest - `DEMUXER_ERROR_COULD_NOT_PARSE`, live and film alike, on a stream
 * that plays perfectly through hls.js in the same WebView. So MSE wins
 * wherever it runs, and the native path is kept for the one place hls.js
 * cannot go - iOS Safari - and as a last resort if hls.js gives up.
 *
 * Loading hls.js on demand keeps it out of the boot bundle, which is what
 * makes startup bearable on weak hardware - so both the live and on-demand
 * players go through here rather than each shipping their own copy of this
 * decision.
 *
 * The bulk of this file is recovery, and that is the point. An IPTV source is
 * not a file on a disk: segments arrive late, a CDN rotates a node mid
 * programme, a box's wifi drops for two seconds. A player that gives up the
 * first time any of that happens is unusable in a hotel even though it works
 * perfectly on a desk. So every failure is treated as survivable until it has
 * proved otherwise, and only then does the viewer get told.
 */

export type StreamKind = 'live' | 'vod';

export interface PlaybackHandlers {
  /** Recovering from something survivable. The curtain says so; nothing else. */
  onRecovering?(): void;
  /** Playing again after a recovery. */
  onRecovered?(): void;
  /** Out of options. This one reaches the viewer. */
  onFatal?(message: string): void;
}

export interface Playback {
  load(url: string, kind: StreamKind): Promise<void>;
  /** 此刻的真实状态，给诊断叠层用。没在放就返回 null。 */
  stats(): PlaybackStats | null;
  destroy(): void;
}

/** How many times one incident may be retried before the viewer is told. */
const MAX_NETWORK_RETRIES = 6;

/** 1s, 2s, 4s... so a source that is genuinely down is not hammered. */
const backoffMs = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 15_000);

/**
 * How long playback may make no progress before it is treated as stalled.
 *
 * This is the failure hls.js cannot report, because from its side nothing has
 * gone wrong: segments keep arriving, the buffer keeps filling, and the video
 * element simply never advances. With nothing watching, it stays that way
 * forever - a still frame, and a clock in the corner still ticking.
 */
const STALL_AFTER_MS = 12_000;
const STALL_POLL_MS = 2_000;

/**
 * Tuning, per kind of stream.
 *
 * Live wants a short buffer: every second held is a second behind the
 * broadcast, and a viewer flicking channels feels it. On demand wants a long
 * one, because nobody minds a film being half a minute ahead of itself. Both
 * want back-buffer capped, which is what stops a three-hour film growing until
 * a 1GB box kills the page, and both want the level capped to the panel - a 4K
 * variant on this hardware does not decode at all, so picking it is strictly
 * worse than picking 1080p.
 */
/**
 * 直播的三档取舍：缓冲越长越不卡，也越落后于直播。
 *
 * 这不是一个能替所有人定下来的值。酒店的上行、盒子的解码能力、客人在看的是
 * 球赛还是新闻，指向完全不同的答案 —— 所以做成一个档位，让运营按现场情况定，
 * 而不是我在这里猜一个「通用最优」。
 *
 *   stable    缓冲 30s，离直播边缘远。上行不稳的楼里首选，几乎不卡。
 *   balanced  缓冲 12s。默认。
 *   low       缓冲 6s，贴着直播边缘。网络好、又在乎「比邻居快一秒」时用，
 *             代价是网络一抖就卡。
 */
export type LiveProfile = 'stable' | 'balanced' | 'low';

const LIVE_PROFILES: Record<LiveProfile, { maxBufferLength: number; maxMaxBufferLength: number; liveSyncDurationCount: number }> = {
  stable: { maxBufferLength: 30, maxMaxBufferLength: 60, liveSyncDurationCount: 6 },
  balanced: { maxBufferLength: 12, maxMaxBufferLength: 30, liveSyncDurationCount: 3 },
  low: { maxBufferLength: 6, maxMaxBufferLength: 15, liveSyncDurationCount: 2 },
};

/**
 * 排查叠层开没开。后台按酒店整店下发，见 bff 的 tvConfig。
 *
 * 放在这里而不是 main.ts：player.ts 要读它，而 main.ts 已经 import 了
 * player.ts —— 反过来再 import 就成了环。这个值本来也属于「播放相关的
 * 运行时配置」，跟下面的档位是一类东西。
 */
let diagnostics = false;
export const setDiagnostics = (on: boolean) => { diagnostics = on; };
export const diagnosticsOn = () => diagnostics;

const PROFILE_KEY = 'wewatch.liveProfile';

/** 运营在后台定的默认值；这台盒子自己改过的话，以自己的为准。 */
let defaultProfile: LiveProfile = 'balanced';

export function setDefaultLiveProfile(p: LiveProfile | null | undefined) {
  if (p && p in LIVE_PROFILES) defaultProfile = p;
}

export function liveProfile(): LiveProfile {
  try {
    const v = localStorage.getItem(PROFILE_KEY);
    if (v && v in LIVE_PROFILES) return v as LiveProfile;
  } catch {
    /* 存储不可用就用后台给的默认值 */
  }
  return defaultProfile;
}

export function setLiveProfile(p: LiveProfile) {
  try {
    localStorage.setItem(PROFILE_KEY, p);
  } catch {
    /* 记不住就只在本次会话生效 */
  }
}

function hlsConfig(kind: StreamKind) {
  const common = {
    enableWorker: true,
    lowLatencyMode: false,
    capLevelToPlayerSize: true,
    // hls.js retries these internally before ever raising a fatal error, which
    // is the cheapest recovery available. The defaults give up too readily for
    // a source on the far side of a hotel uplink.
    /*
     * The first manifest gets a short leash and everything else a long one.
     * A playlist that will not open is usually not going to: the source is
     * gone, or it sends no CORS header and never will. Four retries with
     * exponential backoff spent fifteen seconds establishing that before the
     * relay - which plays it - got a turn. Segments keep the patient settings,
     * because those genuinely do come back.
     */
    manifestLoadingMaxRetry: 2,
    manifestLoadingRetryDelay: 600,
    levelLoadingMaxRetry: 4,
    fragLoadingMaxRetry: 6,
    manifestLoadingTimeOut: 12_000,
    levelLoadingTimeOut: 20_000,
    fragLoadingTimeOut: 30_000,
  };

  return kind === 'live'
    ? { ...common, backBufferLength: 30, ...LIVE_PROFILES[liveProfile()] }
    : { ...common, maxBufferLength: 30, maxMaxBufferLength: 90, backBufferLength: 60 };
}

/**
 * 播放器此刻的真实状态。
 *
 * 存在的理由很具体：一个频道在酒店房间里卡，站在电视前的人分不清是上行不够、
 * 是盒子解不动，还是这条源本来就坏。这三种的处理方式完全不同 ——
 * 换线路、换盒子、换源 —— 而没有这些数字就只能靠猜。
 *
 * 全部现取，不累计、不上报。
 */
export interface PlaybackStats {
  engine: 'hls.js' | 'native' | 'idle';
  /** 当前档位的分辨率与码率 */
  width: number;
  height: number;
  bitrate: number;
  /** 这条流一共有几档可选 */
  levels: number;
  /** 缓冲区里还剩几秒 —— 这个数掉到 0 就是卡顿 */
  bufferAhead: number;
  /** hls.js 对当前带宽的估计，bit/s */
  bandwidth: number;
  /** 丢帧 / 总帧。丢帧多 = 盒子解不动，跟网络无关 */
  dropped: number;
  frames: number;
  /** 落后直播边缘几秒 */
  latency: number | null;
  recovering: boolean;
}

export function createPlayback(video: HTMLVideoElement, handlers: PlaybackHandlers = {}): Playback {
  let hls: HlsType | null = null;
  let hlsCtor: typeof HlsType | null = null;

  let url = '';
  let kind: StreamKind = 'live';

  /** Bumped on every load(), so a reply for the channel before last is dropped. */
  let generation = 0;

  let networkRetries = 0;
  let mediaRecoveries = 0;
  let recovering = false;
  /** Whether this load is running on the platform's own engine. */
  let retryTimer: number | undefined;
  let stallTimer: number | undefined;
  let lastProgressAt = 0;
  let lastPosition = -1;

  // ------------------------------------------------------------- reporting

  function enterRecovery() {
    if (recovering) return;
    recovering = true;
    handlers.onRecovering?.();
  }

  /**
   * Playing again - and the retry budget is restored with it.
   *
   * That reset matters more than it looks: a channel left on for a whole
   * evening will drop and recover many times, and a budget that only ever
   * counted down would eventually fail a stream that had been fine for hours.
   */
  function leaveRecovery() {
    networkRetries = 0;
    mediaRecoveries = 0;
    if (!recovering) return;
    recovering = false;
    handlers.onRecovered?.();
  }

  /**
   * Out of options on this engine.
   *
   * There is deliberately no "try the platform player instead" step here. On
   * the only hardware that has both, the platform player is precisely the one
   * that cannot open these streams, so all it bought was half a minute of
   * "reconnecting" before the caller got to try the thing that works. The
   * escalation that does work - the relay - belongs to the caller, which is
   * the only layer that can mint a URL for it.
   */
  function giveUp(message: string) {
    recovering = false;
    clearTimeout(retryTimer);
    clearInterval(stallTimer);
    handlers.onFatal?.(message);
  }

  // ---------------------------------------------------------------- stall

  /**
   * Nothing here trusts a single reading. Playback legitimately stops while
   * the viewer holds a menu open or scrubs, so the watchdog only fires when
   * the position has genuinely not moved while the element believed itself to
   * be playing.
   */
  function startStallWatch() {
    clearInterval(stallTimer);
    lastProgressAt = Date.now();
    lastPosition = -1;

    stallTimer = window.setInterval(() => {
      if (video.paused || video.ended || video.seeking) {
        lastProgressAt = Date.now();
        return;
      }
      if (video.currentTime !== lastPosition) {
        lastPosition = video.currentTime;
        lastProgressAt = Date.now();
        leaveRecovery();
        return;
      }
      if (Date.now() - lastProgressAt < STALL_AFTER_MS) return;

      lastProgressAt = Date.now();
      recoverStall();
    }, STALL_POLL_MS);
  }

  function recoverStall() {
    if (networkRetries >= MAX_NETWORK_RETRIES) {
      giveUp(t('toast.sourceFail'));
      return;
    }
    networkRetries++;
    enterRecovery();

    if (hls) {
      // Refill from the live edge rather than from wherever the buffer died -
      // catching up through stale segments only puts the viewer further behind.
      hls.stopLoad();
      hls.startLoad(kind === 'live' ? -1 : video.currentTime);
    } else {
      reloadNative();
    }
  }

  // --------------------------------------------------------------- native

  /**
   * The platform's own engine: `video.src = url` and, until this file was
   * rewritten, nothing watching it afterwards - a panel that dropped a stream
   * simply stopped, with the app none the wiser. It is now the fallback rather
   * than the boxes' default, but it still has to recover like everything else.
   */
  function reloadNative() {
    const at = kind === 'vod' ? video.currentTime : 0;
    const mine = generation;
    video.src = url;
    video.load();
    if (at > 0) {
      const seek = () => {
        video.removeEventListener('loadedmetadata', seek);
        if (generation === mine) video.currentTime = at;
      };
      video.addEventListener('loadedmetadata', seek);
    }
    void video.play().catch(() => {});
  }

  function onNativeError() {
    if (hls) return; // hls.js owns the element; its own handler answers for it
    if (networkRetries >= MAX_NETWORK_RETRIES) {
      giveUp(t('toast.sourceFail'));
      return;
    }
    networkRetries++;
    enterRecovery();
    clearTimeout(retryTimer);
    retryTimer = window.setTimeout(reloadNative, backoffMs(networkRetries));
  }

  // ---------------------------------------------------------------- hls.js

  function attachHlsRecovery(Hls: typeof HlsType, instance: HlsType) {
    instance.on(Hls.Events.ERROR, (_e: unknown, data: { fatal?: boolean; type?: string; details?: string }) => {
      // hls.js resolves non-fatal errors on its own; restarting on those would
      // interrupt a stream that was never actually broken.
      if (!data?.fatal) return;

      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          /*
           * A playlist that will not load at all is a different failure from a
           * stream that is dropping segments, and it must not be treated like
           * one. hls.js has already retried the manifest four times of its own
           * accord by the time this is fatal; sitting through another six with
           * backoff only delays the answer by three quarters of a minute. It
           * is also the shape a CORS refusal takes - the request never
           * completes and never will - and above this there is a relay waiting
           * that would have played it. So fail now and let it try.
           */
          if (
            data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
            data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
            data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR
          ) {
            giveUp(t('toast.sourceFail'));
            return;
          }

          if (networkRetries >= MAX_NETWORK_RETRIES) {
            giveUp(t('toast.sourceFail'));
            return;
          }
          networkRetries++;
          enterRecovery();
          clearTimeout(retryTimer);
          retryTimer = window.setTimeout(() => instance.startLoad(), backoffMs(networkRetries));
          return;

        case Hls.ErrorTypes.MEDIA_ERROR:
          // The documented ladder, in order. The codec swap covers a stream
          // that changed audio format mid-flight, which upstream IPTV muxes do
          // more often than anyone would like.
          if (mediaRecoveries === 0) {
            mediaRecoveries++;
            enterRecovery();
            instance.recoverMediaError();
          } else if (mediaRecoveries === 1) {
            mediaRecoveries++;
            enterRecovery();
            instance.swapAudioCodec();
            instance.recoverMediaError();
          } else {
            giveUp(t('toast.sourceFail'));
          }
          return;

        default:
          giveUp(t('toast.sourceFail'));
      }
    });

    // A buffered fragment is the earliest honest proof the stream is healthy
    // again - earlier than `playing`, which waits on the decoder.
    instance.on(Hls.Events.FRAG_BUFFERED, () => leaveRecovery());
  }

  // ------------------------------------------------------------------- api

  function teardown() {
    clearTimeout(retryTimer);
    clearInterval(stallTimer);
    hls?.destroy();
    hls = null;
  }

  video.addEventListener('error', onNativeError);
  video.addEventListener('playing', leaveRecovery);

  /**
   * 现取，不订阅、不累计。
   *
   * 叠层不显示的时候这个函数一次都不会被调用 —— 一个平时就在后台算帧率的
   * 诊断工具，本身就会变成它要诊断的那个卡顿。
   */
  function stats(): PlaybackStats | null {
    if (!video.src && !hls) return null;

    const level = hls && hls.currentLevel >= 0 ? hls.levels?.[hls.currentLevel] : null;
    const q =
      typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;

    let bufferAhead = 0;
    try {
      const b = video.buffered;
      for (let i = 0; i < b.length; i++) {
        if (video.currentTime >= b.start(i) && video.currentTime <= b.end(i)) {
          bufferAhead = b.end(i) - video.currentTime;
          break;
        }
      }
    } catch {
      /* 有些实现在还没数据时直接抛 */
    }

    return {
      engine: hls ? 'hls.js' : video.src ? 'native' : 'idle',
      /*
       * 用 || 不是 ?? —— 这里的 0 是「没有这个值」，不是「值是零」。
       *
       * 很多直播的 m3u8 只有一条流、没写 RESOLUTION，hls.js 的 level.width
       * 就是 0。?? 只在 null/undefined 时回退，0 会被当成有效值原样带出去，
       * 叠层上就显示 0×0 —— 明明画面好好地在放。
       */
      width: level?.width || video.videoWidth || 0,
      height: level?.height || video.videoHeight || 0,
      bitrate: level?.bitrate ?? 0,
      levels: hls?.levels?.length ?? 0,
      bufferAhead,
      bandwidth: (hls as { bandwidthEstimate?: number } | null)?.bandwidthEstimate ?? 0,
      dropped: q?.droppedVideoFrames ?? 0,
      frames: q?.totalVideoFrames ?? 0,
      latency: (hls as { latency?: number } | null)?.latency ?? null,
      recovering,
    };
  }

  return {
    stats,
    async load(nextUrl, nextKind) {
      const mine = ++generation;
      teardown();

      url = nextUrl;
      kind = nextKind;
      /*
       * Clear whatever the element was doing before choosing an engine.
       * hls.js attaches through MediaSource, and attaching it to an element
       * that still carries a `src` from an earlier attempt leaves two players
       * arguing over one element: segments arrive, nothing ever plays, and the
       * curtain never lifts. It cost an afternoon once.
       */
      video.removeAttribute('src');
      video.load();
      networkRetries = 0;
      mediaRecoveries = 0;
      recovering = false;

      // No MSE means no hls.js - iOS, and old WebViews. There the platform
      // engine is the only engine, so take it without paying for the import.
      if (typeof MediaSource === 'undefined' && video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        void video.play().catch(() => {});
        startStallWatch();
        return;
      }

      if (!hlsCtor) {
        const mod = await import('hls.js');
        // A slow import can outlive the channel it was started for.
        if (generation !== mine) return;
        hlsCtor = mod.default;
      }
      const Hls = hlsCtor;

      if (!Hls.isSupported()) {
        video.src = url;
        void video.play().catch(() => {});
        startStallWatch();
        return;
      }

      const instance = new Hls(hlsConfig(kind));
      hls = instance;
      attachHlsRecovery(Hls, instance);
      instance.loadSource(url);
      instance.attachMedia(video);
      void video.play().catch(() => {});
      startStallWatch();
    },

    destroy() {
      generation++;
      teardown();
      video.removeEventListener('error', onNativeError);
      video.removeEventListener('playing', leaveRecovery);
      // Hand the decoder back now rather than at collection time; a box has one
      // or two, and the next screen may need one immediately.
      video.pause();
      video.removeAttribute('src');
      video.load();
    },
  };
}
