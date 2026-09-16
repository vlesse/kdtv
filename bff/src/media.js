/**
 * Uploaded media.
 *
 * Bytes go to disk under MEDIA_DIR (a mounted volume in production, so an
 * image survives a container rebuild); the database only indexes them. The
 * filename is generated here and never taken from the client - an operator
 * uploading `../../etc/nginx/nginx.conf` gets a random name like everything
 * else.
 */
import { createWriteStream } from 'node:fs';
import { mkdirSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { join, extname } from 'node:path';
import { db, now } from './db.js';
import { config } from './config.js';

mkdirSync(config.mediaDir, { recursive: true });

/** Extension -> kind. The allowlist is the security boundary, not the mime. */
const TYPES = {
  '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'],
  '.png': ['image', 'image/png'],
  '.webp': ['image', 'image/webp'],
  '.gif': ['image', 'image/gif'],
  '.mp4': ['video', 'video/mp4'],
  '.webm': ['video', 'video/webm'],
  '.mov': ['video', 'video/quicktime'],
  '.m4v': ['video', 'video/x-m4v'],
};

export function classify(originalName) {
  const ext = extname(String(originalName || '')).toLowerCase();
  const hit = TYPES[ext];
  return hit ? { ext, kind: hit[0], mime: hit[1] } : null;
}

export const publicPath = (filename) => `/media/${filename}`;

/**
 * Does this MP4 start playing before it has finished downloading?
 *
 * An MP4 keeps its index - the `moov` atom - either before the media data or
 * after it. Put it after, and a player cannot show a single frame until the
 * whole file has arrived: a 40MB background loop over a hotel uplink becomes
 * a minute of black instead of a second. It is a one-flag difference at export
 * time ("web optimized" in Handbrake, `-movflags +faststart` in ffmpeg) that
 * nobody thinks about, and it is invisible until it is on a television.
 *
 * So it gets checked here, where the operator can still fix it, by walking the
 * top-level atoms and seeing which of `moov` / `mdat` comes first.
 *
 * Returns true (fine), false (index at the end), or null (not an MP4-family
 * file, or laid out in a way this does not recognise - in which case say
 * nothing rather than guess).
 */
export function startsFast(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(16);
    let at = 0;

    // A dozen atoms is far more than the handful any real file has out front;
    // the cap is what stops a malformed file walking forever.
    for (let i = 0; i < 12; i++) {
      if (readSync(fd, head, 0, 16, at) < 8) return null;

      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (i === 0 && type !== 'ftyp') return null; // not MP4/MOV after all

      if (type === 'moov') return true;
      if (type === 'mdat') return false;

      if (size === 1) size = Number(head.readBigUInt64BE(8)); // 64-bit length
      else if (size === 0) return null; // "to end of file" - nothing follows
      if (size < 8) return null;

      at += size;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Consume an upload stream onto disk.
 *
 * Fastify's multipart already enforces the byte limit; this checks
 * `file.truncated` afterwards because the stream ends normally when the
 * limit trips, and a half-written video that plays for four seconds is a
 * worse failure than a rejected upload.
 */
export async function store(pid, part) {
  const type = classify(part.filename);
  if (!type) throw Object.assign(new Error('不支持的文件格式，只能传 JPG / PNG / WebP / GIF / MP4 / WebM / MOV'), { statusCode: 400 });

  const filename = `${randomUUID()}${type.ext}`;
  const target = join(config.mediaDir, filename);

  await pipeline(part.file, createWriteStream(target));

  if (part.file.truncated) {
    try {
      unlinkSync(target);
    } catch {
      /* nothing to clean up */
    }
    throw Object.assign(new Error('文件太大，超过了上传上限'), { statusCode: 413 });
  }

  const bytes = statSync(target).size;
  const info = db
    .prepare(
      'INSERT INTO media (property_id, filename, original, kind, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(pid, filename, String(part.filename).slice(0, 200), type.kind, type.mime, bytes, now());

  return {
    id: Number(info.lastInsertRowid),
    filename,
    url: publicPath(filename),
    kind: type.kind,
    mime: type.mime,
    bytes,
    // Advisory only. The file is stored either way - it plays, it just may not
    // play promptly, and that is the operator's call to make.
    faststart: type.kind === 'video' ? startsFast(target) : null,
  };
}

export function list(pid = null) {
  return db
    .prepare(
      pid == null
        ? 'SELECT * FROM media ORDER BY created_at DESC, id DESC'
        : 'SELECT * FROM media WHERE property_id = ? ORDER BY created_at DESC, id DESC',
    )
    .all(...(pid == null ? [] : [pid]))
    .map((r) => ({
      id: r.id,
      url: publicPath(r.filename),
      original: r.original,
      kind: r.kind,
      bytes: r.bytes,
      createdAt: r.created_at,
    }));
}

/** 'image' | 'video' | null, looked up from a /media/<filename> path. */
export function kindOf(url) {
  const filename = String(url || '').replace(/^\/media\//, '');
  if (!filename || filename.includes('/')) return null;
  return db.prepare('SELECT kind FROM media WHERE filename = ?').get(filename)?.kind ?? null;
}

export function find(id, pid = null) {
  return (
    db
      .prepare(
        pid == null
          ? 'SELECT * FROM media WHERE id = ?'
          : 'SELECT * FROM media WHERE id = ? AND property_id = ?',
      )
      .get(...(pid == null ? [Number(id)] : [Number(id), pid])) ?? null
  );
}

/** Removes the row and the file. A missing file is not an error - the row goes anyway. */
export function remove(id, pid = null) {
  const row = find(id, pid);
  if (!row) return null;
  db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
  try {
    unlinkSync(join(config.mediaDir, row.filename));
  } catch {
    /* already gone */
  }
  return publicPath(row.filename);
}
