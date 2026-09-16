import { t } from './i18n';

/** Small DOM helpers - enough structure to keep views readable without
    pulling a framework onto a low-powered set-top box. */

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, any>> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'text') el.textContent = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/**
 * Deterministic card gradient plus a readable fallback badge for channels with
 * no logo. A single initial is useless when thirty channels are called CCTV-something,
 * so keep short names whole and abbreviate long ones by word initials.
 */
export function tint(seed: string): { c1: string; c2: string; initial: string } {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return {
    c1: `hsl(${hue} 46% 32%)`,
    c2: `hsl(${(hue + 38) % 360} 52% 16%)`,
    initial: badge(seed),
  };
}

function badge(name: string): string {
  const clean = name.trim();
  if (!clean) return '?';

  // CJK reads densely - two glyphs already identify a channel.
  if (/[一-鿿]/.test(clean)) return clean.slice(0, 2);

  if (clean.length <= 6) return clean.toUpperCase();

  const words = clean.split(/[\s._-]+/).filter(Boolean);
  if (words.length > 1) {
    return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
  }
  return clean.slice(0, 4).toUpperCase();
}

export function hhmm(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function rupiah(n: number): string {
  if (!n) return t('svc.free');
  return 'Rp ' + n.toLocaleString('id-ID');
}

let toastTimer: number | undefined;
export function toast(message: string) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', text: message });
  document.getElementById('app')!.append(t);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.remove(), 2600);
}

export function clock(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
