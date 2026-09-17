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
}

console.log(`\n${'─'.repeat(52)}`);
if (fails.length === 0) {
  console.log(`全部通过：${passed} 项`);
} else {
  console.log(`通过 ${passed} 项，失败 ${fails.length} 项：\n`);
  for (const f of fails) console.log('  ✗ ' + f);
}
process.exit(fails.length === 0 ? 0 : 1);
