/**
 * 旅游周边 —— 酒店附近值得去的地方。
 *
 * 一条就是一个去处：一张图、四种语言的名字和介绍、排序、上不上架。
 * 形状故意和 `service.js` 的菜单一样：前台已经会用那张表了，
 * 再发明一种用法只是多一份要教的东西。
 *
 * **英文名必填**，其它三种语言留空就回退到英文 —— 和菜单同一个规矩。
 * 一家酒店的内容只属于这一家：每个查询都带 `property_id`，
 * 不是靠界面藏（那随便按个 F12 就绕过去了）。
 */
import { db, now } from './db.js';

const LANGS = ['en', 'zh', 'id', 'km'];

const text = (v, max = 120) => {
  const s = String(v ?? '').trim().slice(0, max);
  return s || null;
};

function row(r) {
  return {
    id: r.id,
    name: { en: r.name_en, zh: r.name_zh, id: r.name_id, km: r.name_km },
    desc: { en: r.desc_en, zh: r.desc_zh, id: r.desc_id, km: r.desc_km },
    image: r.image,
    active: Boolean(r.active),
    sortOrder: r.sort_order,
  };
}

/** 后台看的：这一家的全部，上架没上架都在。 */
export function all(pid) {
  return db
    .prepare('SELECT * FROM explore_spots WHERE property_id = ? ORDER BY sort_order, id')
    .all(pid)
    .map(row);
}

/** 电视上看的：只有上架的，而且**必须有图** —— 一张没有图的大卡片是块空白。 */
export function published(pid) {
  return db
    .prepare(
      "SELECT * FROM explore_spots WHERE property_id = ? AND active = 1 AND image IS NOT NULL AND image != '' ORDER BY sort_order, id",
    )
    .all(pid)
    .map(row);
}

export function save(pid, patch) {
  const id = patch?.id == null ? null : Number(patch.id);
  const nameEn = text(patch?.name?.en ?? patch?.nameEn);

  if (!id && !nameEn) {
    throw Object.assign(new Error('英文名必填 —— 其它语言留空会回退到它'), { statusCode: 400 });
  }

  const sets = [];
  const args = [];
  const put = (col, val) => {
    sets.push(`${col} = ?`);
    args.push(val);
  };

  for (const l of LANGS) {
    const n = patch?.name?.[l];
    if (n !== undefined) put(`name_${l}`, l === 'en' ? nameEn : text(n));
    const d = patch?.desc?.[l];
    // 介绍给到 600 字：电视上一屏读得完，再长没人看。
    if (d !== undefined) put(`desc_${l}`, text(d, 600));
  }
  if ('image' in (patch ?? {})) put('image', text(patch.image, 400));
  if ('active' in (patch ?? {})) put('active', patch.active ? 1 : 0);
  if ('sortOrder' in (patch ?? {})) put('sort_order', Number(patch.sortOrder) || 0);

  if (!id) {
    const r = db
      .prepare(
        'INSERT INTO explore_spots (property_id, name_en, created_at, sort_order) VALUES (?, ?, ?, ?)',
      )
      .run(pid, nameEn, now(), Number(patch?.sortOrder) || 0);
    const newId = Number(r.lastInsertRowid);
    if (sets.length) {
      db.prepare(`UPDATE explore_spots SET ${sets.join(', ')} WHERE id = ? AND property_id = ?`).run(
        ...args,
        newId,
        pid,
      );
    }
    return find(pid, newId);
  }

  if (sets.length) {
    db.prepare(`UPDATE explore_spots SET ${sets.join(', ')} WHERE id = ? AND property_id = ?`).run(
      ...args,
      id,
      pid,
    );
  }
  return find(pid, id);
}

export function find(pid, id) {
  const r = db
    .prepare('SELECT * FROM explore_spots WHERE id = ? AND property_id = ?')
    .get(Number(id), pid);
  return r ? row(r) : null;
}

export function remove(pid, id) {
  const r = db
    .prepare('DELETE FROM explore_spots WHERE id = ? AND property_id = ?')
    .run(Number(id), pid);
  return r.changes > 0;
}

/** 有没有上架的内容。首页那一格要不要出现，看这个。 */
export function any(pid) {
  return (
    db
      .prepare(
        "SELECT COUNT(*) n FROM explore_spots WHERE property_id = ? AND active = 1 AND image IS NOT NULL AND image != ''",
      )
      .get(pid).n > 0
  );
}

export const languages = LANGS;
