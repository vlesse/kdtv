/**
 * 频道预览图：每个频道一段 1.5 秒、会自己循环的动图。
 *
 * 频道卡片上原来只有一个台标和一个名字。客人拿着遥控器划过 91 个台，
 * 没有任何线索告诉他此刻哪个台在放什么 —— 只能一个个点进去看。
 *
 * **为什么是动图不是视频。**
 * 直播页的大图早就在放真实时画面了，但它**只预览第一个频道、不跟焦点走**：
 * 跟焦点就是遥控器划过几张卡就开几条流，而机顶盒的硬解码器只有那么几个，
 * 多开一个给预览就少一个给正片。这里换成 ffmpeg 预先截好的 **animated WebP**，
 * 浏览器当图片解，**完全不碰媒体解码器**，循环也不用写代码。
 * 实测一张 480x270 / 15 帧 / 1.5 秒 ≈ 49KB，抓一次约 2 秒。
 *
 * **为什么受限频道一张都不生成。** 图片落在 `/media/` 下，那是公开目录 ——
 * 给成人分类的频道截一张，等于在 PIN 外面开了一扇窗。所以判断的时候
 * 一律按「没解锁」算，解锁过的盒子也不例外。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

const DIR = join(config.mediaDir, 'previews');

/** 同时抓几个。这台机器两个核，抓图和它自己要干的活得共存。 */
const MAX_PARALLEL = 2;

/** 单张最多等多久。抓不到就抓不到，不能把队列堵死。 */
const TIMEOUT_MS = 20_000;

/**
 * 发给上游的 UA 要像浏览器。
 *
 * 不是装饰：有的源对非浏览器 UA 一律 403（5 ATV3 就是这样，中继那次踩过），
 * 于是「这个台抓不出图」看起来像我们的问题，其实是被人家拦了。
 */
const UA =
  'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

let running = 0;
/** 正在抓的 key，防止同一个频道被排两遍。 */
const inFlight = new Set();

const keyOf = (line, streamId) => `${line.panelId}-${streamId}`;
const fileOf = (key) => join(DIR, `${key}.webp`);
const urlOf = (key) => `/media/previews/${key}.webp`;

function ageOf(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Infinity;
  }
}

function capture(line, streamId, key) {
  inFlight.add(key);
  running++;

  mkdirSync(DIR, { recursive: true });
  const out = fileOf(key);
  const tmp = `${out}.${process.pid}.tmp.webp`;

  /*
   * 抓的是**面板的内网/直连地址**，不是给盒子的那个播放地址 —— 这一步是服务器
   * 自己在拉流，走哪条路跟客房里的电视无关。
   */
  const url =
    `${line.api}/live/${encodeURIComponent(line.username)}/` +
    `${encodeURIComponent(line.password)}/${streamId}.m3u8`;

  const ff = spawn(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-user_agent', UA,
      // 上游卡住时别无限等：读超时 8 秒，整个进程 20 秒兜底。
      '-rw_timeout', '8000000',
      '-i', url,
      '-t', '1.5',
      '-an',
      '-vf', 'fps=10,scale=480:-2',
      '-loop', '0',
      '-q:v', '55',
      tmp,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let err = '';
  ff.stderr.on('data', (b) => {
    err = (err + b.toString()).slice(-400);
  });

  const kill = setTimeout(() => ff.kill('SIGKILL'), TIMEOUT_MS);

  const done = (ok) => {
    clearTimeout(kill);
    inFlight.delete(key);
    running--;
    if (ok) {
      // 改名是原子的：读的人要么看到上一张完整的，要么看到新的，
      // 不会撞上写了一半的文件。
      try { renameSync(tmp, out); } catch { /* 目标被同时换掉了，无所谓 */ }
    } else {
      try { unlinkSync(tmp); } catch { /* 本来就没写出来 */ }
    }
  };

  ff.on('error', () => done(false));
  ff.on('close', (code) => done(code === 0 && ageOf(tmp) !== Infinity));
}

/**
 * 这个频道现在有没有图，顺便决定要不要重抓。
 *
 * 永远**立刻返回**：有旧图就先给旧图，新的在后台抓，下次焦点再过来就换成新的。
 * 直播画面一分钟前和现在差别不大，让遥控器等 ffmpeg 才是真的难用。
 */
export function ensure(line, streamId) {
  if (!line?.api || !line?.username) return null;
  const key = keyOf(line, streamId);
  const age = ageOf(fileOf(key));

  if (age > config.previews.ttlMs && !inFlight.has(key) && running < MAX_PARALLEL) {
    capture(line, streamId, key);
  }
  return age === Infinity ? null : { url: urlOf(key), ageMs: age };
}
