/**
 * Jeepay 聚合支付驱动。
 *
 * Jeepay 是自建的聚合支付网关：它对下游接支付宝/微信/银行/加密货币，
 * 我们只跟它说话。这份实现是从 vps-resale-panel 搬过来的 —— 那边真金白银
 * 跑过，踩过的坑都写在注释里，不要「简化」掉。
 *
 * 签名规则是最容易错、也最难查的地方（网关只回「签名错误」四个字）：
 *   1. 取所有非空参数（sign 本身除外）
 *   2. 按参数名 ASCII 升序排列
 *   3. 拼成 k1=v1&k2=v2&...
 *   4. 末尾接 &key=appSecret
 *   5. 整串 MD5，转大写十六进制
 *
 * 「非空」的判定尤其要小心：空字符串要排除，但值为 0 或 "0" 的必须保留 ——
 * 用 JS 的真值判断（if (v)）会把 0 一起扔掉，签名就永远对不上。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * 按 Jeepay 规则算签名。
 * 收单和验签用同一个函数 —— 分成两份实现迟早会一边改了另一边没改。
 */
export function sign(params, appSecret) {
  const keys = Object.keys(params)
    .filter((k) => {
      if (k === 'sign') return false;
      const v = params[k];
      // 不能写 if (v)：值为 0 / "0" 的参数 Jeepay 是算进签名的。
      return v !== undefined && v !== null && v !== '';
    })
    .sort();

  const query = keys.map((k) => `${k}=${params[k]}`).join('&');
  return createHash('md5').update(`${query}&key=${appSecret}`, 'utf8').digest('hex').toUpperCase();
}

/** 验签。回调必须验 —— 不验的话任何人构造一个请求就能把订单标成已付款。 */
export function verify(params, appSecret) {
  const received = String(params?.sign ?? '');
  if (!received) return false;
  const expected = sign(params, appSecret);
  const a = Buffer.from(received.toUpperCase());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 这串东西能不能直接丢给浏览器跳转。 */
function isNavigable(v) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(v).trim());
}

async function post(url, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // 网关正常时一定回 JSON。回来的是 HTML 基本就是地址写错了，
      // 打到了 nginx 的错误页或者某个前端页面上。
      throw new Error(
        `支付网关回的不是 JSON（HTTP ${res.status}）—— 网关地址填到域名为止就行，不要带路径`,
      );
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function explainNetwork(err, gateway) {
  const msg = String(err?.message ?? err);
  if (err?.name === 'AbortError') return `支付网关 ${gateway} 超时没响应`;
  if (/ECONNREFUSED/i.test(msg)) return `连不上支付网关 ${gateway}，检查地址端口，以及 Jeepay 是不是在跑`;
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return `解析不了支付网关域名 ${gateway}，检查地址有没有写错`;
  if (/certificate|SSL|self.signed/i.test(msg)) return '支付网关的 HTTPS 证书有问题（过期或自签）';
  return `请求支付网关失败：${msg}`;
}

function explainGateway(data) {
  const msg = String(data?.msg ?? data?.message ?? '未知错误');
  // 这条要排在「商户」前面：它的原文里也带「商户订单」四个字，
  // 放后面会被抢走，然后提示你去查商户号 —— 查半天查不出问题。
  if (/已存在|重复|duplicate/i.test(msg)) {
    return `网关说这个订单号提交过了：${msg}。同一个商户单号只能提交一次`;
  }
  if (/签名|sign/i.test(msg)) {
    return `支付网关说签名错误：${msg}。检查应用密钥（appSecret）是不是抄错了或前后有空格`;
  }
  if (/商户|mch/i.test(msg)) {
    return `支付网关说商户有问题：${msg}。检查商户号和应用 ID 是否属于同一个商户`;
  }
  if (/金额|amount/i.test(msg)) {
    return `支付网关说金额有问题：${msg}。注意金额单位是「分」不是「元」`;
  }
  return `支付网关拒绝了这笔订单：${msg}`;
}

/**
 * 下单。返回二维码内容或跳转地址。
 *
 * 金额单位是**分**。
 */
export async function createPayment(cred, req) {
  const params = {
    mchNo: cred.mchNo,
    appId: cred.appId,
    mchOrderNo: req.orderNo,
    wayCode: req.wayCode,
    amount: req.amountCents,
    currency: (req.currency || 'CNY').toLowerCase(),
    clientIp: req.clientIp || '127.0.0.1',
    subject: String(req.subject).slice(0, 64),
    body: String(req.body || req.subject).slice(0, 256),
    notifyUrl: req.notifyUrl,
    ...(req.returnUrl ? { returnUrl: req.returnUrl } : {}),
    reqTime: Date.now(),
    version: '1.0',
    signType: 'MD5',
  };
  params.sign = sign(params, cred.appSecret);

  const url = `${String(cred.gatewayUrl).replace(/\/+$/, '')}/api/pay/unifiedOrder`;
  let data;
  try {
    data = await post(url, params, 20_000);
  } catch (err) {
    throw new Error(explainNetwork(err, cred.gatewayUrl));
  }
  if (data.code !== 0) throw new Error(explainGateway(data));

  const d = data.data ?? {};

  // 网关把「跳转地址」和「二维码内容」塞哪个字段，各家不一样，
  // 而且**同一个字段两种都可能**：payData 有时是 https://…，
  // 有时是一长串 EMV 二维码数据（00020101021130…）。
  // 所以按内容判断，不按字段名 —— 以前按字段名分的时候，二维码数据被当成
  // 跳转地址，前端一句 location.href = 那串数字，浏览器当场卡住，
  // 用户点了付款什么都不出来，也没有任何报错。
  const candidates = [d.payUrl, d.payData, d.codeUrl, d.qrCode].filter(
    (v) => typeof v === 'string' && v.length > 0,
  );

  return {
    payOrderId: d.payOrderId,
    payUrl: candidates.find(isNavigable) ?? null,
    codeUrl: candidates.find((v) => !isNavigable(v)) ?? null,
    raw: d,
  };
}

/** Jeepay 的订单状态。只有 2 是收到钱了。 */
const STATE_TEXT = {
  0: '订单已生成，还没提交给上游',
  // 别把 1 读成「用户已经扫了」：扫码类订单在网关发出二维码那一刻就是 1，
  // 跟用户有没有动手无关。
  1: '支付中（码已发出，钱还没确认到）',
  2: '支付成功',
  3: '支付失败',
  4: '已撤销',
  5: '已退款',
  6: '订单已关闭',
};

export const stateText = (s) => STATE_TEXT[s] ?? `未知状态 ${s}`;

/**
 * 反过来问网关：这笔到底收到没有。
 *
 * 回调是「网关主动告诉我们」，这个是「我们主动去问」。两者缺一不可 ——
 * 回调会丢（网络抖动、我们正好在重启、上游根本没发），丢了如果没有第二条路，
 * 客人就是付了钱什么都没发生，而且谁都不知道。
 */
export async function queryOrder(cred, ref) {
  if (!ref.payOrderId && !ref.mchOrderNo) throw new Error('查单至少要给一个单号');

  const params = {
    mchNo: cred.mchNo,
    appId: cred.appId,
    ...(ref.payOrderId ? { payOrderId: ref.payOrderId } : {}),
    ...(ref.mchOrderNo ? { mchOrderNo: ref.mchOrderNo } : {}),
    reqTime: Date.now(),
    version: '1.0',
    signType: 'MD5',
  };
  params.sign = sign(params, cred.appSecret);

  const url = `${String(cred.gatewayUrl).replace(/\/+$/, '')}/api/pay/query`;
  let data;
  try {
    data = await post(url, params, 15_000);
  } catch (err) {
    throw new Error(explainNetwork(err, cred.gatewayUrl));
  }

  if (data.code !== 0) {
    // 「订单不存在」不是故障，是一个明确的答案。
    const msg = String(data?.msg ?? data?.message ?? '');
    if (/不存在|not.?found/i.test(msg)) {
      return { found: false, state: null, paid: false, stateText: `网关说没有这笔单：${msg}`, raw: data };
    }
    throw new Error(explainGateway(data));
  }

  const d = data.data ?? {};
  const state = d.state == null ? null : Number(d.state);
  return {
    found: true,
    state,
    stateText: stateText(state),
    paid: state === 2,
    amountCents: d.amount != null ? Number(d.amount) : undefined,
    payOrderId: d.payOrderId,
    mchOrderNo: d.mchOrderNo,
    raw: d,
  };
}

/**
 * 解析回调。
 *
 * state 2 才是支付成功。其它状态一律不当成功 —— 尤其是 1，
 * 见过把「支付中」当成功然后白送东西的。
 */
export function parseNotify(params, cred) {
  if (!verify(params, cred.appSecret)) {
    return { valid: false, success: false, reason: '签名校验不通过' };
  }
  const state = Number(params.state);
  return {
    valid: true,
    success: state === 2,
    orderNo: params.mchOrderNo,
    upstreamNo: params.payOrderId,
    amountCents: params.amount != null ? Number(params.amount) : undefined,
    reason: state === 2 ? undefined : `${stateText(state)}（只有 2 才是成功）`,
  };
}

/** 测试通道配置对不对。故意用一个不存在的 wayCode 去探。 */
export async function probe(cred) {
  for (const [field, label] of [
    ['gatewayUrl', '网关地址'],
    ['mchNo', '商户号'],
    ['appId', '应用 ID'],
    ['appSecret', '应用密钥'],
  ]) {
    if (!cred?.[field]) return { ok: false, message: `${label}没填` };
  }
  if (!/^https?:\/\//.test(cred.gatewayUrl)) {
    return { ok: false, message: '网关地址要带 http:// 或 https://' };
  }

  try {
    await createPayment(cred, {
      orderNo: `PROBE${Date.now()}`,
      amountCents: 1,
      currency: 'CNY',
      wayCode: '__PROBE__',
      subject: '连通性测试',
      notifyUrl: 'https://example.com/notify',
    });
    return { ok: true, message: '网关连通，签名通过' };
  } catch (err) {
    const msg = String(err.message);
    if (/签名|sign/i.test(msg)) {
      return { ok: false, message: '网关能连上，但签名不通过 —— 检查商户号、应用 ID、应用密钥有没有抄错' };
    }
    // 这正是期待的结果：连通了、签名过了，只是探测用的支付方式不存在。
    if (/支付方式|wayCode|不存在|不支持/i.test(msg)) {
      return { ok: true, message: '网关连通，签名通过（探测用的支付方式不存在属正常）' };
    }
    return { ok: false, message: msg };
  }
}
