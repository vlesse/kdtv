/**
 * 模板 B「直播优先」的菜单。
 *
 * 模板 A 是宫格首页，直播是其中一格；模板 B 反过来 —— **开机就是电视**，
 * 点播、客房服务这些从菜单里进。做两套不是为了好看，是因为两种客人不一样：
 * 度假的会去翻点播和送餐，商务和长住的进门就想看新闻，多按两下都是多余的。
 *
 * 这个菜单**浮在正在播的画面上**，底下的台不停。这是它和模板 A 首页最大的
 * 区别：在电视上，画面一黑就等于"卡住了"，而客人只是想看看有什么别的可看。
 */
import { h } from './ui';
import { icon, type IconName } from './home';
import { focusFirst, grabBack } from './nav';
import { t } from './i18n';

export interface MenuEntry {
  id: string;
  icon: IconName;
  label: string;
  go: () => void;
}

/**
 * 在播放器上面拉出菜单。返回一个关掉它的函数。
 *
 * `host` 就是播放器的根元素 —— 菜单挂在它里面，而不是挂在 document 上，
 * 这样播放器被换掉的时候菜单跟着一起没，不会留下一层浮在新屏幕上的鬼影。
 */
export function openLiveMenu(host: HTMLElement, entries: MenuEntry[], nowPlaying: string): () => void {
  // 已经开着就别再开一个（连按两下菜单键）。
  const existing = host.querySelector<HTMLElement>('.live-menu');
  if (existing) return () => existing.remove();

  let release: (() => void) | null = null;

  function close() {
    release?.();
    release = null;
    delete host.dataset.menu;
    panel.remove();
    // 焦点还给播放器，否则关掉菜单之后方向键没有着落点。
    focusFirst(host);
  }

  const panel = h(
    'div',
    { class: 'live-menu', 'data-modal': 'true' },
    h(
      'div',
      { class: 'live-menu-head' },
      h('span', { class: 'live-menu-kicker', text: t('menu.watching') }),
      h('span', { class: 'live-menu-now', text: nowPlaying }),
    ),
    h(
      'div',
      { class: 'live-menu-row' },
      ...entries.map((e, i) =>
        h(
          'button',
          {
            class: 'live-menu-item focusable',
            ...(i === 0 ? { 'data-autofocus': '' } : {}),
            onclick: () => {
              close();
              e.go();
            },
          },
          icon(e.icon),
          h('span', { text: e.label }),
        ),
      ),
    ),
    h('p', { class: 'live-menu-hint muted', text: t('menu.close') }),
  );

  /*
   * 菜单开着的时候把播放器那条横幅收起来。
   *
   * 两层都贴在屏幕底部，同时显示就是一堆按钮压在另一堆按钮上 —— 实测截图里
   * 「关闭」正好压在「频道列表」上。用属性开关而不是 CSS 的 `:has()`：
   * 机顶盒上的 WebView 版本参差不齐，而这件事不能有一半盒子不生效。
   */
  host.dataset.menu = 'open';
  host.append(panel);
  // 抢下返回键，关掉的时候原样还给播放器 —— 播放器的返回键还管着数字输入
  // 和频道列表，直接覆盖掉的话那两样就再也退不出来了。
  release = grabBack(() => {
    close();
    return true;
  });
  window.setTimeout(() => focusFirst(panel), 0);
  return close;
}
