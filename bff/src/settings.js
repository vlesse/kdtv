/**
 * Operator-editable settings.
 *
 * Everything here also exists as an environment variable in config.js. The
 * env value is the default; a row in `settings` overrides it. That ordering
 * matters: a property can change its own background from the admin console
 * without anyone touching .env or redeploying, and a fresh install with an
 * empty table still boots looking exactly as configured.
 */
import { db, now } from './db.js';
import { config } from './config.js';

const get = db.prepare('SELECT value FROM settings WHERE property_id = ? AND key = ?');
const put = db.prepare(
  'INSERT INTO settings (property_id, key, value, updated_at) VALUES (?, ?, ?, ?)' +
    ' ON CONFLICT(property_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
);
const drop = db.prepare('DELETE FROM settings WHERE property_id = ? AND key = ?');

/**
 * 每一次读写都必须说清楚是哪家酒店的。
 *
 * 酒店 id 是**第一个参数而且没有默认值**，而且类型不对就直接抛 —— 这是故意的。
 * 十家酒店共用一张 settings 表，漏带 id 的后果是读到别家的配置：A 店的电视
 * 显示 B 店的名字、B 店的成人 PIN 开了 A 店的门。这种错误不会报错、不会崩，
 * 只会安静地串台，所以宁可让它在第一次调用时就炸掉。
 *
 * 0 号是平台自己（后台总口令、我们自己的收款商户），1 以上是各家酒店。
 */
function requirePid(pid, who) {
  if (!Number.isInteger(pid) || pid < 0) {
    throw new Error(`${who}: 第一个参数必须是酒店 id（0 = 平台），收到的是 ${JSON.stringify(pid)}`);
  }
  return pid;
}

/** Raw read. Returns null when the key has never been set. */
export function getSetting(pid, key) {
  return get.get(requirePid(pid, 'getSetting'), key)?.value ?? null;
}

/** Writing null or an empty string clears the override and restores the env default. */
export function setSetting(pid, key, value) {
  requirePid(pid, 'setSetting');
  if (value === null || value === undefined || value === '') drop.run(pid, key);
  else put.run(pid, key, String(value), now());
}

// --------------------------------------------------------------- home screen

/**
 * Background kinds the launcher knows how to render.
 *
 * `none` is not "unset" - it is an explicit choice to show the built-in
 * gradient, which is why it has to be distinguishable from a missing row.
 */
const BG_KINDS = new Set(['image', 'video', 'none']);

/** Absolute http(s), or a path on this origin. Anything else is rejected. */
export function safeMediaUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (s.startsWith('/')) return s.replace(/[\s"'()\\]/g, '');
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    new URL(s);
  } catch {
    return null;
  }
  return s.replace(/[\s"'()\\]/g, '');
}

/**
 * What the launcher should paint behind itself.
 *
 * Falls back through: admin choice -> HOME_BACKGROUND_URL -> built-in
 * gradient. The env variable is still honoured because that is how the
 * property was configured before there was a console.
 */
export function homeBackground(pid) {
  const stored = getSetting(pid, 'home.bg.type');
  const kind = BG_KINDS.has(stored) ? stored : null;

  if (kind === 'none') return { type: 'none', url: null, poster: null };

  if (kind) {
    const url = safeMediaUrl(getSetting(pid, 'home.bg.url'));
    if (url) {
      return {
        type: kind,
        url,
        poster: kind === 'video' ? safeMediaUrl(getSetting(pid, 'home.bg.poster')) : null,
      };
    }
  }

  const fromEnv = safeMediaUrl(config.home.backgroundUrl);
  if (fromEnv) return { type: 'image', url: fromEnv, poster: null };
  return { type: 'none', url: null, poster: null };
}

// --------------------------------------------------------------- branding

/** #rgb / #rrggbb only. Anything else is refused rather than pasted into CSS. */
export function safeColor(raw) {
  const v = String(raw ?? '').trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : null;
}

/**
 * Operator-supplied CSS.
 *
 * This is the escape hatch every product like this ends up needing - Jellyfin
 * has exactly the same field - because no fixed set of knobs covers what a
 * particular property will want. It is deliberately NOT sanitised into
 * uselessness: CSS is already confined to presentation, it cannot make
 * requests back out (the page's own connect-src governs that), and the person
 * typing it is the operator who already holds the console password.
 *
 * What is stripped is the one thing CSS should never carry here: `</style>`,
 * which would otherwise close the tag and let markup through. The stylesheet
 * is also served as its own text/css response rather than inlined, so there is
 * no HTML context for it to escape in the first place.
 */
export function safeCss(raw) {
  return String(raw ?? '')
    .replace(/<\/?\s*style/gi, '')
    .slice(0, 20_000);
}

/**
 * A picture per screen.
 *
 * The launcher's background was the only one for a while, and every other
 * screen sat on flat black - which reads like a file manager rather than a
 * television. These are separate settings rather than one, because the rooms
 * that care about this are the ones that want live TV on a different picture
 * from room service.
 *
 * Stills only. A screen with a video behind it costs a decoder, and the box
 * has one or two - the launcher may spend one, the screen you reach by
 * pressing a channel must not.
 */
const SCENE_KEYS = {
  live: 'scene.live',
  vod: 'scene.vod',
  service: 'scene.service',
};

export function sceneConfig(pid) {
  const out = {};
  for (const [field, key] of Object.entries(SCENE_KEYS)) {
    out[field] = safeMediaUrl(getSetting(pid, key));
  }
  return out;
}

export function setScene(pid, field, url) {
  const key = SCENE_KEYS[field];
  if (!key) return false;
  setSetting(pid, key, url || null);
  return true;
}

const BRAND_KEYS = {
  splashUrl: 'brand.splash',
  loadingUrl: 'brand.loading',
  logoUrl: 'brand.logo',
};

export function brandingConfig(pid) {
  const out = {};
  for (const [field, key] of Object.entries(BRAND_KEYS)) {
    out[field] = safeMediaUrl(getSetting(pid, key));
  }
  out.accent = safeColor(getSetting(pid, 'brand.accent'));
  out.customCss = getSetting(pid, 'brand.css') || '';
  return out;
}

/**
 * The stylesheet the TV app links from its <head>.
 *
 * Served as a file rather than injected by script so it lands with the rest of
 * the CSS, before first paint - a theme that arrives after the app has drawn
 * itself is a visible flash of the wrong colours on every boot.
 */
export function themeCss(pid) {
  const brand = brandingConfig(pid);
  const lines = [];

  const vars = [];
  if (brand.accent) vars.push(`  --accent: ${brand.accent};`);
  if (brand.loadingUrl) vars.push(`  --brand-loading: url("${brand.loadingUrl}");`);
  if (brand.splashUrl) vars.push(`  --brand-splash: url("${brand.splashUrl}");`);
  if (vars.length) lines.push(':root {', ...vars, '}');

  if (brand.customCss) {
    lines.push('', '/* --- operator CSS ------------------------------------------- */', brand.customCss);
  }

  return lines.join('\n') + '\n';
}

/**
 * 电视端的行为开关（不是外观）。
 *
 * `diagnostics` 是给上门排查的人用的：整店打开，每台电视右上角出现码率、
 * 带宽、缓冲、丢帧。走之前关掉。做成后台开关而不是遥控器上的秘密按键 ——
 * 房间里的遥控器没有 info 键，而且没人想教前台一串暗号。
 *
 * `liveProfile` 只是**默认值**。某台盒子自己在播放器里换过档，以它自己的为准 ——
 * 那台电视前面的人比后台更知道它此刻卡不卡。
 */
const LIVE_PROFILES = new Set(['stable', 'balanced', 'low']);

/**
 * 电视上用哪一套界面。
 *
 *   portal  酒店门户：开机是宫格首页，直播只是其中一格。
 *   live    直播优先：开机直接进直播全屏，别的从菜单进。
 *
 * 做成**按酒店选**，是因为这两种没有优劣之分，只有场合之分：
 * 度假酒店的客人会去翻点播和客房服务，门户更合适；商务酒店和长住公寓的客人
 * 进门就是开电视看新闻，多按两下都是多余的。同一个 APP 同一套后台，
 * 哪家用哪套由前台自己定。
 *
 * 默认 portal —— 已经在用的酒店不会因为这次改动变样。
 */
const TEMPLATES = new Set(['portal', 'live']);

export function tvConfig(pid) {
  const p = getSetting(pid, 'ui.liveProfile');
  const tpl = getSetting(pid, 'ui.template');
  return {
    diagnostics: getSetting(pid, 'ui.diagnostics') === '1',
    liveProfile: LIVE_PROFILES.has(p) ? p : 'balanced',
    template: TEMPLATES.has(tpl) ? tpl : 'portal',
  };
}

export function setTv(pid, patch) {
  if ('diagnostics' in patch) {
    setSetting(pid, 'ui.diagnostics', patch.diagnostics ? '1' : null);
  }
  if ('liveProfile' in patch) {
    const v = String(patch.liveProfile ?? '');
    if (!LIVE_PROFILES.has(v)) {
      throw Object.assign(new Error('直播模式只能是 stable / balanced / low'), { statusCode: 400 });
    }
    setSetting(pid, 'ui.liveProfile', v);
  }
  if ('template' in patch) {
    const v = String(patch.template ?? '');
    if (!TEMPLATES.has(v)) {
      throw Object.assign(new Error('电视模板只能是 portal / live'), { statusCode: 400 });
    }
    setSetting(pid, 'ui.template', v);
  }
  return tvConfig(pid);
}

export function homeConfig(pid) {
  return {
    tv: tvConfig(pid),
    propertyName: getSetting(pid, 'home.propertyName') || config.home.propertyName,
    supportContact: getSetting(pid, 'home.supportContact') || config.home.supportContact || null,
    welcomeText: getSetting(pid, 'home.welcomeText') || null,
    background: homeBackground(pid),
    scenes: sceneConfig(pid),
    branding: brandingConfig(pid),
    version: config.appVersion,
  };
}
