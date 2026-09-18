/**
 * 界面更新了就自己换上，不用去现场重启盒子。
 *
 * 这套系统的卖点是「更新一百台盒子 = 重新部署一次 BFF」。但盒子上的 WebView
 * **只在开机那一次去取页面**，之后一直跑着不会再取 —— 也就是说部署完，
 * 墙上那台电视还是旧界面，要等它下次断电重启才会变。
 *
 * 实测踩到过：后台早就部署好了，电视上什么都没变，看起来像功能没做出来。
 *
 * 所以这里定期问一句「网页换了没」，换了就在**没人用的时候**重新加载。
 * 判断「网页换了没」不能用 APP_VERSION —— 那是环境变量里写死的，部署不会动它；
 * 用的是服务端算出来的页面指纹（见 BFF 的 bundleId）。
 */
import { api } from './api';

/** 多久问一次。够勤快，又不至于让上百台盒子反复打扰服务器。 */
const POLL_MS = 15 * 60_000;

/** 多久没人按遥控器算「没人用」。 */
const IDLE_MS = 3 * 60_000;

let lastKey = Date.now();

/**
 * 现在换页面会不会打扰到人。
 *
 * 三条都要过：**没在看电视**（播放器开着就是有人在看，画面一黑就是事故）、
 * **没有浮层开着**（正在点餐、正在输 PIN，刷新就是把人正在填的东西扔掉）、
 * **最近没人按遥控器**。
 */
function safeToReload(): boolean {
  if (document.querySelector('.player.screen')) return false;
  if (document.querySelector('[data-modal="true"]')) return false;
  return Date.now() - lastKey > IDLE_MS;
}

export function startUpdater() {
  document.addEventListener('keydown', () => { lastKey = Date.now(); }, true);

  let known: string | null = null;
  let pending = false;

  const check = async () => {
    let bundle: string | null = null;
    try {
      bundle = (await api.appVersion()).bundle ?? null;
    } catch {
      return; // 网络不好而已，下一轮再说
    }
    if (!bundle) return;

    if (known === null) {
      known = bundle;
      return;
    }
    if (bundle !== known) pending = true;

    /*
     * 记住「有新版本」这件事，而不是错过就算了：这一刻可能有人正在看电视，
     * 等他关掉之后我们还是要换上去，不能等下一个 15 分钟碰巧撞上空闲。
     */
    if (pending && safeToReload()) location.reload();
  };

  setInterval(check, POLL_MS);
  // 空闲检查比问服务器勤：新版本已经知道了，剩下的只是等一个没人用的时刻。
  setInterval(() => {
    if (pending && safeToReload()) location.reload();
  }, 30_000);

  void check();
}
