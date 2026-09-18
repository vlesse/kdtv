/**
 * 把每个频道的预览图轮着补一遍。
 *
 * 光靠焦点触发是不够的：客人要的是**整屏扫过去每个台都有画面**，
 * 而不是「光标移到哪张才有哪张」。所以得有人主动把 91 个台从头走一遍。
 *
 * 一轮 91 个台、两个并行、每个约 2 秒，大概一分半跑完，默认 20 分钟一轮 ——
 * 一个核大约一成的占用。上游流量贵的地方把 `PREVIEW_SWEEP_MS` 设成 0 就只剩
 * 焦点触发。
 *
 * **按「线路 + 面板」去重，不是按酒店。** 十家酒店共用一条默认线路是常态，
 * 按酒店扫就是同一批频道抓十遍。
 */
import { config } from './config.js';
import * as properties from './properties.js';
import * as previews from './previews.js';
import * as xui from './xui.js';
import * as adult from './adult.js';

/** 这台服务器上一共有几套「线路 + 面板」的组合。 */
function lineSets() {
  const seen = new Map();
  for (const p of properties.all()) {
    if (!p.active) continue;
    const line = properties.callLineFor(p);
    if (!line.username || !line.api) continue;
    // 同一条线路 + 同一台面板 = 同一批频道，抓一遍就够。
    const key = `${line.panelId}:${line.username}`;
    if (!seen.has(key)) seen.set(key, { line, propertyId: p.id });
  }
  return [...seen.values()];
}

async function once(log) {
  for (const { line, propertyId } of lineSets()) {
    let streams;
    try {
      streams = await xui.liveStreams(line);
    } catch (err) {
      log.warn({ err: err.message }, 'preview sweep: 取不到频道列表');
      continue;
    }
    if (!Array.isArray(streams) || !streams.length) continue;

    /*
     * 受限频道一个都不抓。图片落在公开的 /media/ 下，给成人分类截一张
     * 等于在 PIN 外面开窗 —— 跟哪台盒子解没解锁无关，文件存在谁都能取。
     */
    let skip = new Set();
    try {
      const ids = await adult.restrictedIds({
        property_id: propertyId,
        line_user: line.username,
        line_pass: line.password,
      });
      skip = ids?.live ?? new Set();
    } catch {
      /* 算不出来就宁可少抓：下面那句把整条线路跳过 */
      log.warn('preview sweep: 算不出受限频道，这一轮跳过这条线路');
      continue;
    }

    const r = await previews.sweep(
      line,
      streams.map((s) => s.stream_id),
      skip,
    );
    if (r.captured) log.info({ captured: r.captured, line: line.username }, 'preview sweep 完成一轮');
  }
}

export function startPreviewSweeper(log) {
  const every = config.previews.sweepMs;
  if (!every) {
    log.info('preview sweep 已关闭（PREVIEW_SWEEP_MS=0）');
    return;
  }

  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await once(log);
    } catch (err) {
      log.warn({ err: err.message }, 'preview sweep 出错');
    } finally {
      busy = false;
    }
  };

  /*
   * 开机不要立刻开抓：这时候正有一批盒子在要频道列表、要首页配置，
   * 两个核不该先拿去跑 ffmpeg。等一分钟再开始。
   */
  setTimeout(run, 60_000).unref?.();
  setInterval(run, every).unref?.();
}
