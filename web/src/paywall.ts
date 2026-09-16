/**
 * 要钱的那两块界面。
 *
 * 一块是「这个要买」——列出几档价格；另一块是「扫这个码」——出二维码并且
 * 一直等到钱到账。客房服务的付款和买观看权走的是同一块，因为对客人来说
 * 那就是同一件事：电视上出个码，拿手机扫。
 *
 * 这是整个产品里唯一一处客人要掏钱的界面，所以有几条不太一样的规矩：
 *
 *  - **等待期间不能让人以为卡住了。** 二维码下面一直有倒计时和一行状态，
 *    不是一个转圈的图标。
 *  - **返回键永远能走。** 付款过程中按返回不该被拦住 —— 客人改主意了就是
 *    改主意了，钱还没付，没有任何理由困住他。单子留在那里自己过期。
 *  - **付成功要停得住。** 到账之后轮询立刻停掉，界面换成一句确认再自动退出，
 *    不能继续敲服务器。
 */
import { api, type BillingStatus, type PaymentOrder } from './api';
import { h, toast } from './ui';
import { t } from './i18n';
import { focusFirst, onBack } from './nav';

/** 两秒一次，比人扫码到付完的节奏快，又不会把服务器打满。 */
const POLL_MS = 2000;

function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 一个盖住全屏的浮层，带自己的返回处理。
 *
 * 返回的 close() 是幂等的：轮询定时器和按键监听都挂在同一个关闭动作上，
 * 少解绑一个就是一台没人看还在每两秒发请求的电视。
 */
function overlay(sheet: HTMLElement, onClose?: () => void) {
  const backdrop = h('div', { class: 'backdrop pay-backdrop' }, sheet);
  document.getElementById('app')!.append(backdrop);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    backdrop.remove();
    onBack(null);
    onClose?.();
  }

  onBack(() => {
    close();
    return true;
  });
  focusFirst(backdrop);
  return { backdrop, close, isClosed: () => closed };
}

/**
 * 出码，等钱。
 *
 * `onPaid` 只会被调用一次，而且一定是在轮询停掉之后。
 */
export function showPayment(order: PaymentOrder, opts: { onPaid?: () => void; title?: string } = {}) {
  const status = h('p', { class: 'pay-status', text: t('pay.scanHint') });
  const clock = h('span', { class: 'pay-clock', text: mmss(order.expiresAt - Date.now() / 1000) });

  const qrBox = h('div', { class: 'pay-qr' });
  if (order.qrSvg) {
    // 服务端画好的 SVG。这里是唯一一处往页面里塞标记的地方，内容来自我们
    // 自己的服务端、且只可能是 <svg> —— 二维码的内容本身是被编码成方块的，
    // 不会变成标记。
    qrBox.innerHTML = order.qrSvg;
  } else if (order.payUrl) {
    qrBox.append(h('p', { class: 'muted', text: order.payUrl }));
  } else {
    qrBox.append(h('p', { class: 'muted', text: t('pay.noCode') }));
  }

  const sheet = h(
    'div',
    { class: 'sheet pay-sheet' },
    h('h2', { text: opts.title ?? t('pay.title') }),
    h('p', { class: 'pay-subject', text: order.subject }),
    h('div', { class: 'pay-amount', text: order.amountText }),
    qrBox,
    status,
    h('p', { class: 'muted pay-expiry' }, t('pay.expiresIn') + ' ', clock),
    h('button', {
      class: 'btn ghost focusable',
      style: 'margin-top:1.1rem',
      text: t('pay.later'),
      onclick: () => stop(),
    }),
  );

  let timer = 0;
  let ticker = 0;
  let done = false;

  const view = overlay(sheet, () => {
    clearTimeout(timer);
    clearInterval(ticker);
  });

  function stop() {
    view.close();
  }

  ticker = window.setInterval(() => {
    const left = order.expiresAt - Date.now() / 1000;
    clock.textContent = mmss(left);
    if (left <= 0 && !done) {
      status.textContent = t('pay.expired');
      clearInterval(ticker);
    }
  }, 1000);

  async function poll() {
    if (view.isClosed() || done) return;
    try {
      const { order: fresh } = await api.payStatus(order.orderNo);
      if (view.isClosed()) return;

      if (fresh.state === 'paid') {
        done = true;
        clearInterval(ticker);
        status.textContent = t('pay.paid');
        sheet.classList.add('paid');
        // 停一下让人看清「已付款」再退，不然界面会闪一下就没了，
        // 客人不确定到底成没成。
        window.setTimeout(() => {
          stop();
          opts.onPaid?.();
        }, 1600);
        return;
      }
      if (fresh.state === 'expired' || fresh.state === 'failed') {
        done = true;
        clearInterval(ticker);
        status.textContent = t('pay.expired');
        return;
      }
    } catch {
      // 网络抖一下不该把付款界面打掉 —— 钱可能正在路上。下一轮再问。
    }
    timer = window.setTimeout(poll, POLL_MS);
  }

  timer = window.setTimeout(poll, POLL_MS);
  return { close: stop };
}

/**
 * 「这块要买」。
 *
 * 只在服务端已经回了 402 之后才会出现 —— 界面不自己判断该不该收费，
 * 那个判断只有一个地方做得对，就是服务端。
 */
export async function showPaywall(section: 'live' | 'vod' | 'adult', onUnlocked?: () => void) {
  let status: BillingStatus;
  try {
    status = await api.billingStatus();
  } catch {
    toast(t('pay.unavailable'));
    return;
  }

  if (!status.locked.includes(section)) {
    // 服务端刚才说要钱，现在又说不用 —— 多半是酒店那边刚好续上了。
    onUnlocked?.();
    return;
  }

  const sheet = h('div', { class: 'sheet pay-sheet' });
  const view = overlay(sheet);

  const plans = status.plans.map((p) =>
    h(
      'button',
      {
        class: 'btn focusable pay-plan',
        onclick: async () => {
          try {
            const { payment } = await api.buyPass(p.days);
            view.close();
            showPayment(payment, { onPaid: () => onUnlocked?.() });
          } catch (err) {
            toast((err as Error).message || t('pay.unavailable'));
          }
        },
      },
      h('span', { class: 'pay-plan-days', text: t('pay.days', { n: p.days }) }),
      h('span', { class: 'pay-plan-price', text: p.priceText }),
    ),
  );

  sheet.append(
    h('h2', { text: t('pay.lockedTitle') }),
    h('p', { class: 'muted', text: t(`pay.locked.${section}`) }),
    h('div', { class: 'pay-plans' }, ...plans),
    h('button', {
      class: 'btn ghost focusable',
      style: 'margin-top:1.1rem',
      text: t('player.back'),
      onclick: () => view.close(),
    }),
  );
  focusFirst(sheet);
}

/** 某个报错是不是「这个要花钱」。 */
export const isPaymentRequired = (err: unknown) => (err as { status?: number })?.status === 402;
