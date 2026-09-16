/**
 * 汉字 → 拼音首字母。
 *
 * 存在的理由：片库里 868 部片，**852 部是纯中文片名**。而遥控器上没有键盘，
 * 电视上的软键盘只能打字母。也就是说，一个只按片名匹配的搜索框，
 * 对这个片库等于完全没用 —— 客人打不出「深渊无间」里的任何一个字。
 *
 * 所以搜索要按首字母走：打 `sywj` 找到《深渊无间》，打 `xqg` 找到《小气鬼》。
 * 这是中文电视上通行的做法，也是唯一能用遥控器完成的做法。
 *
 * ---
 *
 * 实现上没有引任何拼音库，用的是 Node 自带的 ICU：
 * `Intl.Collator('zh-Hans-u-co-pinyin')` 会按拼音给汉字排序，于是「这个字的
 * 声母是什么」就变成了「它落在哪两个边界字之间」——一次二分，23 次比较。
 *
 * 边界字必须是**每个声母的第一个音节**，不是随便挑一个：
 * s 那格要用「仨」(sa) 而不是「四」(si)，否则 shen 排在 si 前面，
 * 「深」会被归到 r。这个错我犯过一次，14 个样本里错了 1 个。
 *
 * 多音字按排序结果走，不做词典消歧 —— 搜索匹配的是「打几个字母能不能找到」，
 * 不是「注音对不对」，一个字母偏差不影响找得到。
 */

const collator = new Intl.Collator('zh-Hans-u-co-pinyin');

/** 每个声母的第一个音节：a ba ca da e fa ga ha ji ka la ma na o pa qi ran sa ta wa xi ya za */
const BOUNDARIES = ['阿', '八', '擦', '搭', '蛾', '发', '噶', '哈', '击', '咖', '垃', '妈', '拿', '哦', '趴', '七', '然', '仨', '塌', '挖', '昔', '压', '匝'];
const LETTERS = 'abcdefghjklmnopqrstwxyz'.split('');

const HAN = /[一-鿿]/;

/** 单字的首字母。非汉字原样小写返回，标点返回空串。 */
function letterOf(ch) {
  if (!HAN.test(ch)) return /[a-z0-9]/i.test(ch) ? ch.toLowerCase() : '';

  let lo = 0;
  let hi = BOUNDARIES.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (collator.compare(ch, BOUNDARIES[mid]) >= 0) {
      hit = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return hit >= 0 ? LETTERS[hit] : '';
}

/*
 * 片库每次刷新都要把 868 个片名重算一遍，而片名之间大量重复用字。
 * 按**单字**缓存（不是按整条片名），几百个不同的字很快就都在表里了。
 */
const cache = new Map();

function cachedLetter(ch) {
  let v = cache.get(ch);
  if (v === undefined) {
    v = letterOf(ch);
    // 常用汉字撑死几千个，不会无限涨；真涨到上限就整个丢掉重来，
    // 比维护一个 LRU 简单得多，代价只是偶尔重算一轮。
    if (cache.size > 20_000) cache.clear();
    cache.set(ch, v);
  }
  return v;
}

/**
 * 一条片名的首字母串。
 *
 * 「深渊无间」→ `sywj`，「坠落2：死点」→ `zl2sd`。
 * 数字和字母原样留着，标点丢掉 —— 客人不会去打冒号。
 */
export function initials(text) {
  let out = '';
  for (const ch of String(text ?? '')) out += cachedLetter(ch);
  return out;
}
