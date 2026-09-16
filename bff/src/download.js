/**
 * The installer page.
 *
 * A hotel rollout is someone standing at a television with a remote and a
 * phone. They need three things: a URL short enough to type on an on-screen
 * keyboard, proof that the file they got is the file we published, and the
 * version, so "did you install the new one?" has an answer.
 *
 * Everything on the page is read off the actual file on disk. A page that
 * states a version the APK does not have is worse than no page.
 */
import { statSync, createReadStream, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { config } from './config.js';

const APK = 'tv.apk';

/** Hashing 2.6MB on every page load is silly; mtime is enough to know. */
let cached = null;

async function apkInfo() {
  let st;
  try {
    st = statSync(join(config.mediaDir, APK));
  } catch {
    return null;
  }
  if (cached && cached.mtime === st.mtimeMs) return cached;

  const sha = await new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(join(config.mediaDir, APK))
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });

  /*
   * The version comes from a sidecar written when the APK is published, not
   * from APP_VERSION - that is the *web bundle's* version, and the two move
   * independently (the whole point of the thin shell is that the UI ships
   * without the APK). A page that prints the wrong one sends a technician to
   * reinstall something that was already current.
   */
  let version = null;
  try {
    version = JSON.parse(readFileSync(join(config.mediaDir, APK + '.json'), 'utf8')).version || null;
  } catch {
    /* no sidecar - say so rather than guess */
  }

  cached = { mtime: st.mtimeMs, bytes: st.size, sha, version, at: st.mtime.toISOString().slice(0, 10) };
  return cached;
}

const QR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMYAAADGAQAAAACh4MLwAAABpUlEQVR4nO1YMW7DMBCjLAMZpR/JP+ib8rAC8lPyA2k/gwUlJ1M7tEN9QzTIhgQDBI9HXhKI79ex/HABvG8AsGmPJFAiaWkSWcwFO4Uk+sa2G4C+RVKAFw/YEMKGdF9Rjgykih5WX6oqhj0+tgsR/HjTQ8gA9vUX3/zHDVmRGFsJuegs0bxg20MI6KpmbIiP7QiDw+VybOC5qqFYqmxqW5IuPKRva9+mzERalo1oXy7HBrLGJvYAGApbiRR75gIb5WnSvxqB5MwI84CtldhgqVoSgWMvljzoTXlqryRN1ZStoy+Wy7EtAG5K0n192siRteN6bJDAmvwWqU4zUWVd8AaFgkYRAbPRFPI6J3pjfc1v0p7gOdIbUjWNbfcj4/bYYsPNid5aGb1JSW5QN0488Kaa2tPlFBBteIgTvbUSW5mkPc8U9+YB21yjlDO59OKkpk171HhZ56Tkxt+W83fWSZc6VK3hpk8xuJLGThqdZP1yPtUL+wwvevG39Xz2bCuIEgDLYP/49FFTjnly2JryS97roqY4+/TlulNsLvo0vP/jwl94+wI8pz3OaciQ0QAAAABJRU5ErkJggg==';

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function page(info, origin) {
  const version = info?.version ?? '未标注';
  const mb = info ? (info.bytes / 1024 / 1024).toFixed(2) : '-';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>KDTV 安装包</title><link rel="icon" href="data:," />
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0d1117; color:#e6edf3;
         font:15px/1.7 system-ui,"Microsoft YaHei","PingFang SC",sans-serif; }
  .wrap { max-width:620px; margin:0 auto; padding:40px 20px 80px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:#8b949e; font-size:13.5px; margin:0 0 28px; }
  .card { background:#161b22; border:1px solid #262d38; border-radius:12px; padding:22px; margin-bottom:18px; }
  .big { display:block; text-align:center; background:#2f81f7; color:#fff; text-decoration:none;
         padding:16px; border-radius:10px; font-size:17px; font-weight:600; }
  .big:hover { background:#1f6feb; }
  dl { margin:18px 0 0; display:grid; grid-template-columns:auto 1fr; gap:7px 16px; font-size:13.5px; }
  dt { color:#8b949e; white-space:nowrap; }
  dd { margin:0; word-break:break-all; font-family:ui-monospace,Menlo,Consolas,monospace; }
  .url { text-align:center; font-size:20px; font-family:ui-monospace,Menlo,Consolas,monospace;
         letter-spacing:.5px; background:#0d1117; border:1px dashed #30363d;
         border-radius:8px; padding:14px; margin:0 0 18px; }
  .qr { display:block; margin:0 auto 6px; width:180px; height:180px; image-rendering:pixelated;
        background:#fff; padding:8px; border-radius:8px; }
  .qr-cap { text-align:center; color:#8b949e; font-size:12.5px; margin:0; }
  h2 { font-size:15px; margin:0 0 10px; }
  ol { margin:0; padding-left:20px; color:#c9d1d9; font-size:14px; }
  ol li { margin-bottom:7px; }
  .muted { color:#8b949e; font-size:12.5px; }
  code { background:#0d1117; padding:1px 6px; border-radius:4px; font-size:12.5px; }
</style></head><body><div class="wrap">

<h1>KDTV 安装包</h1>
<p class="sub">机顶盒客户端。装好开机即用，不用填服务器地址。</p>

<div class="card">
  <p class="url">${esc(origin)}/apk</p>
  <a class="big" href="/media/${APK}" download>下载 APK（${mb} MB）</a>
  <dl>
    <dt>版本</dt><dd>${esc(version)}</dd>
    <dt>发布</dt><dd>${info ? esc(info.at) : '-'}</dd>
    <dt>SHA-256</dt><dd>${info ? esc(info.sha) : '安装包还没上传'}</dd>
  </dl>
</div>

<div class="card">
  <img class="qr" src="${QR}" alt="扫码下载" />
  <p class="qr-cap">手机扫码下载，再传到盒子上</p>
</div>

<div class="card">
  <h2>装到盒子上</h2>
  <ol>
    <li>盒子的浏览器或文件管理器里打开 <code>${esc(origin)}/apk</code></li>
    <li>系统会提示「未知来源」，允许一次即可</li>
    <li>装完在应用列表里找 <strong>KDTV</strong>，打开</li>
    <li>没分房的盒子会显示一个 6 位配对码，在后台
        <code>/admin/</code> → 房间与设备 里填房间号即可</li>
  </ol>
  <p class="muted" style="margin-top:14px">
    能连 adb 的话更快：<code>adb install -r tv.apk</code>。<br />
    换过签名的安装包装不上去，要先卸载旧版 —— 本版起签名固定，以后都能直接覆盖升级。
  </p>
</div>

</div></body></html>`;
}

export function registerDownload(app) {
  // Short enough to type on a television's on-screen keyboard.
  app.get('/apk', async (req, reply) => reply.redirect(`/media/${APK}`));

  for (const path of ['/download', '/download/']) {
    app.get(path, async (req, reply) => {
      const info = await apkInfo();
      // Configured address first; the request's own is only right when nothing
      // is in front of us. See config.publicBaseUrl.
      const origin = config.publicBaseUrl || `${req.protocol}://${req.hostname}`;
      reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Cache-Control', 'no-cache');
      return page(info, origin);
    });
  }
}
