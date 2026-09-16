/**
 * 点播搜索。
 *
 * 片库 868 部，**852 部是纯中文片名**，而客人手里只有一个遥控器。
 * 这两件事决定了这个界面的全部形状：
 *
 *  - **按拼音首字母找**。打 `sywj` 出《深渊无间》。片名里的字，客人一个都
 *    打不出来；首字母是遥控器唯一能表达的东西。首字母串由服务端算好带下来
 *    （见 bff/src/pinyin.js），这里只做内存过滤。
 *
 *  - **软键盘是主角，不是配角**。桌面上搜索框是主角、键盘是系统的；电视上
 *    反过来 —— 客人全部的操作都在这块字母格子里，所以它占左边一整列，
 *    每个键都大到能用方向键点得中。
 *
 *  - **打一个字母出一次结果**。不需要按「搜索」。遥控器上多一次确认就是
 *    多一次「我按了怎么没反应」。
 *
 * 结果为空时给的是**建议而不是道歉**：告诉客人首字母怎么打，因为第一次用的
 * 人多半会去试着打片名的拼音全拼。
 */
import { api, type VodItem } from './api';
import { h } from './ui';
import { t } from './i18n';
import { posterCard } from './vod';
import { focusFirst, onBack } from './nav';

/** 软键盘的排布。数字单独一行 —— 片名里的数字（《坠落2》）也是线索。 */
const ROWS = ['ABCDEFG', 'HIJKLMN', 'OPQRSTU', 'VWXYZ', '0123456789'];

/** 一屏最多画多少张海报。见 paint() 里的说明。 */
const MAX_SHOWN = 60;

/**
 * 一条片子有多匹配。0 = 不匹配。
 *
 * **开头的优先，中间的靠后** —— 这一条是整个搜索好不好用的关键。
 * 只用「包含」的话，打一个 Z 会命中 329 部（片名里任何一个字是 z 声母都算），
 * 等于没筛。而人打第一个字母时想的是「这片名是 Z 开头的」。
 *
 * 中间的匹配仍然留着，只是排在后面：《坠落2：死点》的 `zl2sd`，
 * 有人会去打 `sd`，那也该找得到，只是不该排在 Z 开头的那一百部前面。
 *
 * 年份单独算一档：「2026」是「今年的片」这种找法，跟片名无关。
 */
function score(item: VodItem, q: string): number {
  if (!q) return 1;
  const py = (item as VodItem & { py?: string }).py ?? '';
  const name = item.name.toLowerCase();

  if (py.startsWith(q) || name.startsWith(q)) return 3;
  if (py.includes(q) || name.includes(q)) return 2;
  if ((item.year ?? '').includes(q)) return 1;
  return 0;
}

export function searchView(
  items: VodItem[],
  onOpen: (item: VodItem) => void,
  onExit: () => void,
): HTMLElement {
  let query = '';

  const queryEl = h('div', { class: 'search-query' });
  const countEl = h('div', { class: 'search-count' });
  const results = h('div', { class: 'rail-track posters search-results' });

  function paint() {
    queryEl.replaceChildren(
      query
        ? h('span', { class: 'search-typed', text: query.toUpperCase() })
        : h('span', { class: 'search-placeholder', text: t('search.placeholder') }),
      h('span', { class: 'search-caret' }),
    );

    const hits = items
      .map((i) => ({ i, s: score(i, query) }))
      .filter((x) => x.s > 0)
      // 稳定排序：同分的保持片库原有顺序，不要每打一个字母就整体乱跳。
      .sort((a, b) => b.s - a.s)
      .map((x) => x.i);

    const shown = hits.slice(0, MAX_SHOWN);
    countEl.textContent = !query
      ? t('search.hint')
      : hits.length > shown.length
        ? t('search.countCapped', { n: hits.length, shown: shown.length })
        : t('search.count', { n: hits.length });

    if (query && !hits.length) {
      results.replaceChildren(
        h(
          'div',
          { class: 'search-empty' },
          h('p', { text: t('search.noneTitle') }),
          // 空结果给的是用法提示，不是「抱歉」——第一次用的人多半在打全拼。
          h('p', { class: 'muted', text: t('search.noneHint') }),
        ),
      );
      return;
    }

    // 只画前 60 张。再多客人也不会按着方向键翻过去，而每多一张就是一次
    // 海报请求 —— 盒子上这笔开销是真的。多出来的在计数里说清楚。
    results.replaceChildren(...shown.map((it) => posterCard(it, onOpen)));
  }

  function type(ch: string) {
    if (query.length >= 20) return;
    query += ch.toLowerCase();
    paint();
  }

  function back() {
    query = query.slice(0, -1);
    paint();
  }

  function clear() {
    query = '';
    paint();
  }

  const keyboard = h(
    'div',
    { class: 'search-keys' },
    ...ROWS.map((row) =>
      h(
        'div',
        { class: 'search-row' },
        ...[...row].map((ch) =>
          h('button', { class: 'search-key focusable', text: ch, onclick: () => type(ch) }),
        ),
      ),
    ),
    h(
      'div',
      { class: 'search-row search-row-actions' },
      h('button', { class: 'search-key wide focusable', text: t('search.del'), onclick: back }),
      h('button', { class: 'search-key wide focusable', text: t('search.clear'), onclick: clear }),
    ),
  );

  /*
   * 实体键盘也要能用。
   *
   * 房间里只有遥控器，但装机和排查的人手里常常插着一个 USB 键盘 ——
   * 让他们能直接打字，比逼着他们用方向键点二十下强。
   */
  function onKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (/^[a-zA-Z0-9]$/.test(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      type(e.key);
      return;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      back();
    }
  }
  document.addEventListener('keydown', onKey, true);

  const root = h(
    'div',
    { class: 'screen search-screen' },
    h(
      'header',
      { class: 'topbar' },
      h('button', {
        class: 'back-btn focusable',
        text: '‹',
        'aria-label': t('player.back'),
        onclick: onExit,
      }),
      h('h1', { class: 'section-title', text: t('search.title') }),
    ),
    h(
      'div',
      { class: 'search-body' },
      h('div', { class: 'search-pane' }, queryEl, countEl, keyboard),
      h('div', { class: 'search-hits' }, results),
    ),
  );

  root.addEventListener('remove-hook', () => document.removeEventListener('keydown', onKey, true));

  onBack(() => {
    onExit();
    return true;
  });

  paint();
  // 焦点落在第一个字母上，客人按下的第一个键就有用。
  window.setTimeout(() => focusFirst(keyboard), 0);
  return root;
}

/** 片库刷新后重新取一次，让搜索看到的和点播页一致。 */
export async function freshItems(): Promise<VodItem[]> {
  const { items } = await api.vod();
  return items;
}
