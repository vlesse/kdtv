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

/*
 * 一次抓出两样东西：
 *
 *   **静图 .jpg**  每一张卡片的底图，不管有没有焦点 —— 客人扫一眼整屏就知道
 *                  这会儿各台在放什么。
 *   **动图 .webp** 只给当前有焦点的那一张。91 张同时解动图，盒子会跪。
 *
 * 两个都从同一条连接里出，所以多这一张静图基本不要钱。
 */
const keyOf = (line, streamId) => `${line.panelId}-${streamId}`;
const fileOf = (key) => join(DIR, `${key}.webp`);
const stillOf = (key) => join(DIR, `${key}.jpg`);
const urlOf = (key) => `/media/previews/${key}.webp`;
const stillUrlOf = (key) => `/media/previews/${key}.jpg`;

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
  const still = stillOf(key);
  const stillTmp = `${still}.${process.pid}.tmp.jpg`;

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
      /*
       * 这两个不是可选项，去掉一个就一张也抓不出来。
       *
       * ffmpeg 7 以后的 HLS 解复用器会按**扩展名**决定一个分片能不能读，
       * 而这些源的分片地址长这样：`http://cdn-live.example-upstream.net:8807/hls/O58hGD8V…`
       * —— 根本没有扩展名。于是它直接报
       * `not in allowed_segment_extensions` + `Invalid data found`，
       * 看起来像流坏了，其实是 ffmpeg 自己不肯读。
       * （面板自带的 4.4 没这个限制，所以在面板上手试是通的 —— 差点被这个骗过去。）
       */
      '-extension_picky', '0',
      '-allowed_extensions', 'ALL',
      '-i', url,
      '-t', '1.5',
      '-an',
      '-vf', 'fps=10,scale=480:-2',
      '-loop', '0',
      '-q:v', '55',
      tmp,
      // 第二路输出：同一条连接里再落一张静图，给不带焦点的卡片当底图。
      '-frames:v', '1',
      '-an',
      '-vf', 'scale=480:-2',
      '-q:v', '6',
      stillTmp,
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
      try { renameSync(stillTmp, still); } catch { /* 静图没出来不影响动图 */ }
    } else {
      try { unlinkSync(tmp); } catch { /* 本来就没写出来 */ }
      try { unlinkSync(stillTmp); } catch { /* 同上 */ }
      /*
       * 失败要出声。
       *
       * 这个功能坏掉的样子是「卡片上一直没有图」—— 一个不会报错、也没人会去
       * 查的静默故障。第一次上线就是这样：ffmpeg 嫌分片没扩展名，一张没出，
       * 接口一直老老实实回 `url: null`。
       */
      if (err) console.warn(`[preview] ${key} 抓失败: ${err.trim().split('\n').pop()}`);
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

/**
 * 这个频道的静图地址，没有就是 null。**只查文件，不触发抓取。**
 *
 * `/api/channels` 每次都会把 91 个频道问一遍，要是顺手触发抓取，
 * 一次开机就排出 91 个 ffmpeg —— 补图是扫描器的活（下面），不是列表接口的。
 */
export function still(line, streamId) {
  if (!line?.api || !line?.username) return null;
  const key = keyOf(line, streamId);
  return ageOf(stillOf(key)) === Infinity ? null : stillUrlOf(key);
}

// ------------------------------------------------------------------ 扫描器

/*
 * 客人要的是**整屏一眼看过去每个台都有画面**，不是「光标移过去才有」。
 * 所以不能等焦点来触发，得有人把 91 个台从头到尾轮着抓一遍。
 *
 * 一轮 91 个台、两个并行、每个约 2 秒 ≈ 一分半。默认 20 分钟一轮，
 * 也就是一个核大约一成的占用。想更勤快或更省，调 PREVIEW_SWEEP_MS。
 */
let sweeping = false;

async function waitForSlot() {
  while (running >= MAX_PARALLEL) await new Promise((r) => setTimeout(r, 300));
}

/**
 * 把一条线路上的一批频道轮着抓一遍。
 *
 * `skip` 是受限频道的 id —— 那些一张都不抓（图片在公开目录下，
 * 给成人分类截一张等于在 PIN 外面开窗）。
 */
export async function sweep(line, streamIds, skip = new Set()) {
  if (sweeping) return { skipped: true };
  sweeping = true;
  let done = 0;
  try {
    for (const id of streamIds) {
      if (skip.has(Number(id))) continue;
      const key = keyOf(line, id);
      if (ageOf(fileOf(key)) <= config.previews.ttlMs) continue;
      await waitForSlot();
      if (!inFlight.has(key)) {
        capture(line, id, key);
        done++;
      }
    }
    // 等最后几个落地，免得调用方以为已经抓完了。
    while (running > 0) await new Promise((r) => setTimeout(r, 300));
  } finally {
    sweeping = false;
  }
  return { captured: done };
}
