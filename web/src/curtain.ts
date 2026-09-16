import { h } from './ui';
import { t } from './i18n';

/**
 * What the viewer looks at while a stream is not showing.
 *
 * Between pressing a channel and the first frame there is a real wait - the
 * BFF answers, the panel issues a redirect, the CDN opens a connection, the
 * player pulls a manifest and then a segment. Left alone that is several
 * seconds of black, which on a television reads as a broken box rather than a
 * loading one. So it is covered, with the property's own picture and the name
 * of the thing being tuned to, so the wait at least looks intentional.
 *
 * Who decides what it shows: the curtain reacts to the video element for the
 * two things the element alone can settle - it started, it stalled - and takes
 * everything else from the playback layer, which is the only place that knows
 * whether a failure is being retried or is final. It deliberately does not
 * listen for `error` itself any more: doing so used to declare a stream dead
 * while the recovery ladder was still working through it.
 */
export type CurtainState = 'hidden' | 'loading' | 'buffering' | 'recovering' | 'failed';

export interface Curtain {
  el: HTMLElement;
  /** Cover the screen and name what is being tuned to. */
  show(label: string, sub?: string): void;
  /** Wire up a video element so the curtain lifts and returns on its own. */
  attach(video: HTMLVideoElement): void;
  /** A survivable interruption. Says so, and keeps the picture. */
  recovering(): void;
  /** Stay up, say what went wrong, and offer a way to try again. */
  fail(message: string): void;
  hide(): void;
  /** What the retry button on a failure should do. */
  onRetry(fn: () => void): void;
}

export function createCurtain(): Curtain {
  const title = h('div', { class: 'curtain-title' });
  const sub = h('div', { class: 'curtain-sub' });
  const status = h('div', { class: 'curtain-status', text: t('player.connecting') });

  let retryFn: (() => void) | null = null;

  /**
   * Only reachable on a failure, and focusable, because a remote has no other
   * way to press it. Without this the only escape from a dead channel is Back
   * and a second trip through the list.
   */
  const retryBtn = h('button', {
    class: 'btn focusable curtain-retry',
    text: t('player.retry'),
    onclick: () => retryFn?.(),
  });

  const el = h(
    'div',
    { class: 'curtain', 'data-state': 'hidden' },
    h('div', { class: 'curtain-photo' }),
    h(
      'div',
      { class: 'curtain-body' },
      title,
      sub,
      h(
        'div',
        { class: 'curtain-wait' },
        h('div', { class: 'curtain-dots' }, h('i'), h('i'), h('i')),
        status,
      ),
      retryBtn,
    ),
  );

  // Distinguishes "has not started yet" from "started and stalled", which is
  // the whole basis for showing a curtain versus a corner indicator.
  let started = false;

  function setState(state: CurtainState) {
    el.dataset.state = state;
    if (state === 'loading') status.textContent = t('player.connecting');
    if (state === 'buffering') status.textContent = t('player.buffering');
    if (state === 'recovering') status.textContent = t('player.reconnecting');
  }

  return {
    el,

    show(label, subtitle = '') {
      started = false;
      title.textContent = label;
      sub.textContent = subtitle;
      setState('loading');
    },

    hide() {
      setState('hidden');
    },

    /**
     * A programme that was playing keeps its picture through a recovery - the
     * stream is expected back, and covering it would hide the moment it
     * returns. One that never started keeps the full curtain it already has.
     */
    recovering() {
      if (el.dataset.state !== 'failed') setState('recovering');
    },

    /**
     * A stream that will not play keeps the curtain, it does not lose it.
     *
     * Dropping it on a failure hands the viewer a black screen and no reason
     * for it - the exact thing this component exists to prevent. Better they
     * see the channel they chose, a plain sentence saying the source is
     * unreachable, and a button.
     */
    fail(message) {
      started = false;
      setState('failed');
      status.textContent = message;
      // Focus has to be moved deliberately: as far as the remote is concerned
      // this button did not exist until now.
      queueMicrotask(() => retryBtn.focus({ preventScroll: true }));
    },

    onRetry(fn) {
      retryFn = fn;
    },

    attach(video) {
      video.addEventListener('playing', () => {
        started = true;
        setState('hidden');
      });
      /*
       * `waiting` fires in two situations this must tell apart. Before
       * anything has played it is just the initial load, and downgrading the
       * full curtain to a corner indicator would uncover a black screen. And
       * during a recovery it fires constantly - the element is starved
       * because the stream is being re-fetched - so letting it through would
       * replace "reconnecting" with "buffering", which says the wrong thing
       * about what is happening and why it might take a while.
       */
      video.addEventListener('waiting', () => {
        const state = el.dataset.state;
        if (started && state !== 'failed' && state !== 'recovering') setState('buffering');
      });
    },
  };
}
