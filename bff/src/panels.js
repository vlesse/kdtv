/**
 * 接了哪几台 XUI / Xtream 面板。
 *
 * 以前面板只有一台，地址写在环境变量里，全平台共用 —— 想给某一家酒店换一台
 * 面板，只能改服务器配置再重启，十家一起跟着换。现在面板是一张表，
 * 每家酒店各自指一台。
 *
 * **面板和线路是两件事，别混**：
 *   面板 = 一台服务器（一整套后台、片库、推流）；
 *   线路 = 那台面板上的一个账号，决定它能看到哪些套餐、能几个房间同时看。
 * 换线路是换「看到什么」，换面板是换「从哪台机器拿」。
 * 所以一条线路只在它自己那台面板上有效 —— 把 A 面板的线路填给指着 B 面板的
 * 酒店，认证会失败，那家的电视会全黑。
 */
import { db, now } from './db.js';

const text = (v, max = 200) => {
  const s = String(v ?? '').trim().slice(0, max);
  return s || null;
};

/** 去掉末尾的斜杠，省得拼出 `…//live/…`。 */
const trimEnd = (u) => String(u ?? '').trim().replace(/\/+$/, '');

const SELECT = 'SELECT * FROM panels';

export function list() {
  return db.prepare(`${SELECT} ORDER BY id`).all();
}

export function find(id) {
  if (!Number.isInteger(Number(id))) return null;
  return db.prepare(`${SELECT} WHERE id = ?`).get(Number(id)) ?? null;
}

/**
 * 平台默认那一台。
 *
 * 酒店没指定面板时用它。`slug = 'default'` 这一行是从环境变量建出来的，
 * 所以升级上来的库行为不变；万一它被删了，退回 id 最小的那一台，
 * 总比返回 null 让每个调用点都得判空强。
 */
export function fallback() {
  return (
    db.prepare(`${SELECT} WHERE slug = 'default'`).get() ??
    db.prepare(`${SELECT} ORDER BY id LIMIT 1`).get() ??
    null
  );
}

/** 这家酒店该走哪台面板。传 null / 没指定的，都落到默认那台。 */
export function forProperty(property) {
  return (property?.panel_id != null ? find(property.panel_id) : null) ?? fallback();
}

function validate({ slug, name, apiBase, publicBase }, { requireAll = true } = {}) {
  const out = {};
  if (slug !== undefined || requireAll) {
    const s = text(slug, 32);
    // slug 会出现在反代路径里（/stream/<slug>/），所以限制成可以安全放进 URL 的字符。
    if (!s || !/^[a-z0-9][a-z0-9-]*$/.test(s)) {
      throw Object.assign(new Error('标识只能用小写字母、数字和减号，且不能以减号开头'), {
        statusCode: 400,
      });
    }
    out.slug = s;
  }
  if (name !== undefined || requireAll) {
    const n = text(name, 60);
    if (!n) throw Object.assign(new Error('面板要有个名字'), { statusCode: 400 });
    out.name = n;
  }
  for (const [key, label, value] of [
    ['api_base', '接口地址', apiBase],
    ['public_base', '播放地址', publicBase],
  ]) {
    if (value === undefined && !requireAll) continue;
    const u = trimEnd(value);
    if (!u) throw Object.assign(new Error(`${label}不能留空`), { statusCode: 400 });
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad');
    } catch {
      throw Object.assign(new Error(`${label}要是一个完整的地址，带 http:// 或 https://`), {
        statusCode: 400,
      });
    }
    out[key] = u;
  }
  return out;
}

export function create(patch) {
  const v = validate(patch);
  if (db.prepare('SELECT 1 FROM panels WHERE slug = ?').get(v.slug)) {
    throw Object.assign(new Error('这个标识已经有人用了'), { statusCode: 409 });
  }
  const r = db
    .prepare(
      'INSERT INTO panels (slug, name, api_base, public_base, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(v.slug, v.name, v.api_base, v.public_base, text(patch.note, 300), now());
  return find(Number(r.lastInsertRowid));
}

export function update(id, patch) {
  const panel = find(id);
  if (!panel) return null;
  const v = validate(patch, { requireAll: false });
  if (v.slug && v.slug !== panel.slug) {
    if (db.prepare('SELECT 1 FROM panels WHERE slug = ? AND id != ?').get(v.slug, panel.id)) {
      throw Object.assign(new Error('这个标识已经有人用了'), { statusCode: 409 });
    }
  }
  if ('note' in patch) v.note = text(patch.note, 300);
  const cols = Object.keys(v);
  if (cols.length) {
    db.prepare(`UPDATE panels SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
      ...cols.map((c) => v[c]),
      panel.id,
    );
  }
  return find(panel.id);
}

/**
 * 删一台面板。
 *
 * **还有酒店指着它就不让删** —— 删掉的后果不是报错，是那几家酒店悄悄退回默认
 * 面板、换了一整套片库，而没有任何人被告知。最后一台也不让删，否则整个平台
 * 没有面板可用。
 */
export function remove(id) {
  const panel = find(id);
  if (!panel) return { ok: false, error: '面板不存在' };

  const used = db
    .prepare('SELECT name FROM properties WHERE panel_id = ? ORDER BY name')
    .all(panel.id)
    .map((p) => p.name);
  if (used.length) {
    return {
      ok: false,
      error: `还有 ${used.length} 家酒店在用这台面板（${used.slice(0, 3).join('、')}${
        used.length > 3 ? ' 等' : ''
      }）。先把它们改到别的面板。`,
    };
  }
  if (db.prepare('SELECT COUNT(*) n FROM panels').get().n <= 1) {
    return { ok: false, error: '这是最后一台面板，删了就没有片源了' };
  }

  db.prepare('DELETE FROM panels WHERE id = ?').run(panel.id);
  return { ok: true };
}

/** 后台看得到的样子。面板地址不是秘密，但顺手带上「几家在用」。 */
export function overview() {
  const counts = new Map(
    db
      .prepare('SELECT panel_id, COUNT(*) n FROM properties WHERE panel_id IS NOT NULL GROUP BY panel_id')
      .all()
      .map((r) => [r.panel_id, r.n]),
  );
  const fb = fallback();
  return list().map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    apiBase: p.api_base,
    publicBase: p.public_base,
    note: p.note,
    isDefault: p.id === fb?.id,
    // 指定了这一台的 + （默认那台还要算上所有没指定的）
    properties:
      (counts.get(p.id) ?? 0) +
      (p.id === fb?.id
        ? db.prepare('SELECT COUNT(*) n FROM properties WHERE panel_id IS NULL').get().n
        : 0),
  }));
}
