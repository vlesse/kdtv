/**
 * 单文件界面的自检：后台 /admin/ 和前台 /desk/。
 *
 *   node scripts/ui-check.js
 *
 * 为什么需要这个脚本：这两个页面是「一个 HTML 里塞一整段内联 JS」，
 * 没有构建步骤，所以**没有任何东西会在发布前解析它**。里面写错一个字符，
 * 服务端照样 200 把文件发出去，浏览器解析到那一行就整段放弃 ——
 * 结果是一片空白，而所有 curl 检查全是绿的。
 *
 * 真出过：`$('tvProfile').onchange = () >` 少了一个 `=`，
 * 后台在浏览器里白了很久，因为巡检只看 HTTP 状态码。
 *
 * 查两件事：
 *   1. 内联脚本能不能解析（这条是致命的，挂了整页都没了）
 *   2. 代码里 $('xxx') 取的 id，页面上到底有没有
 *      —— 取不到就是 null，下一行 .onchange 直接抛，后果和语法错一样
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const PAGES = ['src/admin-ui/index.html', 'src/desk-ui/index.html'];

let passed = 0;
const fails = [];

function ok(label, cond) {
  if (cond) passed++;
  else fails.push(label);
}

for (const rel of PAGES) {
  const html = readFileSync(join(root, rel), 'utf8');
  const name = relative('.', rel).replace(/\\/g, '/');

  // ---------------------------------------------------------------- 语法
  const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  ok(`${name}：有内联脚本可查`, scripts.length > 0);

  let allParsed = true;
  scripts.forEach((m, i) => {
    let err = null;
    try {
      // eslint-disable-next-line no-new-func
      new Function(m[1]);
    } catch (e) {
      err = e.message;
      allParsed = false;
    }
    ok(`${name}：第 ${i + 1} 段内联脚本能解析${err ? ` —— ${err}` : ''}`, err === null);
  });

  // 解析都过不了，下面的 id 检查没有意义
  if (!allParsed) continue;

  // ------------------------------------------------------------ id 引用
  const js = scripts.map((m) => m[1]).join('\n');

  // 页面上"存在"的 id：不只看 id="x" 属性，模板字符串里拼出来的也算，
  // 否则动态渲染的节点会全部报成误判。
  const declared = new Set();
  for (const m of html.matchAll(/\bid\s*=\s*["']([A-Za-z][\w-]*)["']/g)) declared.add(m[1]);
  for (const m of html.matchAll(/\bid\s*=\s*\\?["']([A-Za-z][\w-]*)\\?["']/g)) declared.add(m[1]);

  const referenced = new Set();
  for (const m of js.matchAll(/\$\(\s*['"]([A-Za-z][\w-]*)['"]\s*\)/g)) referenced.add(m[1]);
  for (const m of js.matchAll(/getElementById\(\s*['"]([A-Za-z][\w-]*)['"]\s*\)/g)) referenced.add(m[1]);

  const missing = [...referenced].filter((id) => !declared.has(id));
  ok(
    `${name}：$('…') 取的 id 页面上都有${missing.length ? ` —— 缺 ${missing.join(', ')}` : ''}`,
    missing.length === 0,
  );

  // ------------------------------------------------------- hidden 藏不藏得住
  /*
   * `el.hidden = true` 靠的是浏览器自带的 `[hidden] { display: none }`。
   * 那是**浏览器**的样式表 —— 只要我们给同一个元素的类写了 display，
   * 作者样式就赢了，这一句变成空话，而且**不会报任何错**。
   *
   * 真出过：`#app` 带着 class="wrap"，而 `.wrap { display: grid }`。
   * 结果没登录的人打开 /admin/ 会看见登录卡片下面整个控制台的壳；
   * 前台点了「退出」，上一份房间表和客人姓名也还留在屏幕上。
   *
   * 所以：只要这一页用了 hidden 属性，就必须有一条兜底规则压回去。
   */
  const usesHiddenAttr = /<[^>]+\shidden(\s|>|=)/.test(html) || /\.hidden\s*=/.test(js);
  if (usesHiddenAttr) {
    const guarded = /\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/.test(html);

    // 顺手指出是哪几个元素会中招，好让人知道为什么要这条规则。
    const risky = [];
    const styled = new Set();
    for (const m of html.matchAll(/\.([a-zA-Z][\w-]*)[^{]*\{[^}]*display:\s*[^;}]+/g)) {
      styled.add(m[1]);
    }
    for (const m of html.matchAll(/<[^>]*\sclass\s*=\s*["']([^"']+)["'][^>]*\shidden(\s|>|=)/g)) {
      for (const c of m[1].split(/\s+/)) if (styled.has(c)) risky.push(c);
    }

    ok(
      `${name}：hidden 真的能藏住东西${
        !guarded && risky.length
          ? ` —— 这些类名出现在设了 display 的规则里，压得过 hidden：${[...new Set(risky)].join(', ')}`
          : ''
      }`,
      guarded,
    );
  }
}

console.log(`\n${'─'.repeat(52)}`);
if (fails.length === 0) {
  console.log(`全部通过：${passed} 项`);
} else {
  console.log(`通过 ${passed} 项，失败 ${fails.length} 项：\n`);
  for (const f of fails) console.log('  ✗ ' + f);
}
process.exit(fails.length === 0 ? 0 : 1);
