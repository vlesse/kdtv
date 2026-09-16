/**
 * D-pad spatial navigation.
 *
 * A TV remote only gives us up/down/left/right/OK/back, so focus has to be
 * inferred from geometry rather than DOM order. Anything with the `focusable`
 * class takes part; the nearest element in the pressed direction wins, biased
 * so that a candidate drifting sideways loses to one directly ahead.
 */

type Dir = 'up' | 'down' | 'left' | 'right';

const KEYS: Record<string, Dir | 'enter' | 'back'> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Escape: 'back',
  Backspace: 'back',
  // Android TV / MAG remotes surface Back as these.
  BrowserBack: 'back',
  GoBack: 'back',
};

let backHandler: (() => boolean) | null = null;

/** Register a handler for the remote's Back button. Return true if handled. */
export function onBack(fn: (() => boolean) | null) {
  backHandler = fn;
}

/**
 * 临时接管返回键，还回一个「交还」的函数。
 *
 * 给的是盖在某个屏幕之上的临时层用的（模板 B 的菜单就是）：它得先抢下返回键，
 * 关掉的时候再原样还给下面那一层。`onBack` 是「谁最后设谁算」，
 * 临时层用它的话，关掉之后下面那一屏的返回键就永远失灵了 —— 在电视上
 * 意味着客人按返回没有任何反应，只能拔电源。
 */
export function grabBack(fn: () => boolean): () => void {
  const prev = backHandler;
  backHandler = fn;
  return () => {
    backHandler = prev;
  };
}

function focusables(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.focusable')).filter((el) => {
    if (el.hasAttribute('disabled')) return false;

    // A faded-out or slid-away panel still has layout, so geometry alone would
    // happily hand focus to controls the viewer cannot see. Honour the flags
    // its owner sets instead.
    if (el.closest('[aria-hidden="true"], [data-hidden="true"]')) return false;

    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;

    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  });
}

function centre(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
}

function pick(from: HTMLElement, dir: Dir): HTMLElement | null {
  const a = centre(from);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const el of focusables()) {
    if (el === from) continue;
    const b = centre(el);
    const dx = b.x - a.x;
    const dy = b.y - a.y;

    // Must actually lie in the pressed direction, with a small dead zone so
    // near-aligned rows do not steal focus from a genuine sideways move.
    const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
    if (along <= 8) continue;

    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);

    // Overlap on the perpendicular axis is what makes a candidate feel "in
    // line", so reward it rather than relying on centre distance alone.
    const overlap =
      dir === 'left' || dir === 'right'
        ? Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
        : Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);

    /*
     * 同一行/同一列的候选**永远**优先，不管远近。
     *
     * 只按距离加权（along + across*3）在一个地方会错得很明显：标题栏最左边是
     * 返回键、最右边是搜索和语言，中间隔着 1500 多像素；而正下方的海报只隔
     * 几十像素。按右键时，那张海报哪怕主要在「下面」，分数也照样比同一行的
     * 搜索低 —— 于是焦点一头扎进内容区，标题栏右边那几个按钮**按右键永远够不到**。
     *
     * 所以把「有没有在同一条线上」提成一个硬档位：有重叠的先比，没重叠的
     * 只有在同一条线上什么都没有时才考虑。这也是 Android 自己的空间导航
     * 采用的规则。
     */
    const aligned = overlap > 0;

    /*
     * 重叠加分要封顶，上限是**来源元素自己的宽/高**。
     *
     * 不封顶的话，一个特别宽的按钮能靠重叠量赢过正下方的窄按钮：搜索页
     * 字母行下面是数字行（10 个窄键）、再下面是「删除/清空」（2 个宽键），
     * 从 W 按下会直接跳过数字行落到「删除」—— 因为宽键跟 W 的重叠算出来
     * 比窄数字键大得多，多到足以抵掉多出来的那段距离。
     *
     * 封顶之后，重叠最多只能「完全盖住来源」，再宽也不多给分，于是近的赢。
     */
    const span = dir === 'left' || dir === 'right' ? a.r.height : a.r.width;
    const bonus = Math.min(Math.max(0, overlap), span) * 1.5;
    const score = (aligned ? 0 : 1e6) + along + across * 3 - bonus;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

export function focus(el: HTMLElement | null) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
}

/** Focus the first sensible element, preferring one marked data-autofocus. */
export function focusFirst(root: ParentNode = document) {
  const preferred = root.querySelector<HTMLElement>('.focusable[data-autofocus]');
  focus(preferred ?? root.querySelector<HTMLElement>('.focusable'));
}

export function initNav() {
  document.addEventListener('keydown', (e) => {
    const action = KEYS[e.key];
    if (!action) return;

    if (action === 'back') {
      e.preventDefault();
      if (backHandler?.()) return;
      return;
    }

    const active = document.activeElement as HTMLElement | null;

    if (action === 'enter') {
      // Let native controls handle their own activation.
      if (active?.classList.contains('focusable')) {
        e.preventDefault();
        active.click();
      }
      return;
    }

    e.preventDefault();
    if (!active || !active.classList.contains('focusable')) {
      focusFirst();
      return;
    }
    focus(pick(active, action));
  });

  // A real remote has no pointer, but the browser preview and touch panels do.
  document.addEventListener('mouseover', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.focusable');
    if (el) el.focus({ preventScroll: true });
  });
}
