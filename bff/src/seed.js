/**
 * 曾经是「首次启动种一份示例数据」，现在不种了。
 *
 * 示例数据在单店时代是方便：装好就有东西可看。多租户之后它变成了害处 ——
 *
 *  1. **新开一家酒店应该是一张白纸。** 湄公河酒店的前台第一次登录，不该看到
 *     一份印尼宿舍的炒饭菜单和三个叫 Li Wei / Budi Santoso 的假住客，
 *     然后要挨个删掉。
 *  2. **它会把清理做的功白做。** 房间表一空就重新种回去，运营会以为自己
 *     没删干净。
 *  3. 这些 INSERT 是单店时代写的，不带 property_id，种出来的是一批
 *     谁也看不见的孤儿行。
 *
 * 剩下的只有一件事：给升级上来的老库补柬埔寨语菜名。那是迁移，不是示例。
 */
import { db } from './db.js';

// category, en, zh, id, km, price, sort
// The Khmer here is a first pass and should be read by a native speaker before
// this menu goes in front of residents.
const MENU = [
  ['Makanan', 'Nasi Goreng Spesial', '特色炒饭', 'Nasi Goreng Spesial', 'បាយឆាពិសេស', 35000, 1],
  ['Makanan', 'Mie Ayam Bakso', '鸡肉丸子面', 'Mie Ayam Bakso', 'មីមាន់ និងបាល់សាច់', 30000, 2],
  ['Makanan', 'Ayam Penyet', '碎炸鸡', 'Ayam Penyet', 'មាន់ចៀន', 40000, 3],
  ['Makanan', 'Bubur Ayam', '鸡肉粥', 'Bubur Ayam', 'បបរមាន់', 25000, 4],
  ['Minuman', 'Es Teh Manis', '冰甜茶', 'Es Teh Manis', 'តែទឹកកកផ្អែម', 8000, 1],
  ['Minuman', 'Kopi Susu', '奶咖', 'Kopi Susu', 'កាហ្វេទឹកដោះគោ', 15000, 2],
  ['Minuman', 'Air Mineral', '矿泉水', 'Air Mineral', 'ទឹកសុទ្ធ', 5000, 3],
  ['Layanan Kamar', 'Ganti Handuk', '更换毛巾', 'Ganti Handuk', 'ប្ដូរកន្សែង', 0, 1],
  ['Layanan Kamar', 'Bersih-bersih Kamar', '房间清洁', 'Bersih-bersih Kamar', 'សម្អាតបន្ទប់', 0, 2],
  ['Layanan Kamar', 'Laundry', '洗衣服务', 'Laundry', 'បោកខោអាវ', 20000, 3],
  ['Layanan Kamar', 'Perbaikan / Maintenance', '维修报修', 'Perbaikan', 'ជួសជុល', 0, 4],
];

export function seedIfEmpty() {
  /*
   * 只补一件事：Khmer 这一列是后加的，老库里的菜品缺它。
   * 按英文名对齐回填，重复执行无害。
   *
   * 这里**不再新建任何东西** —— 房间、菜单、通知都由各家酒店自己填。
   */
  const fill = db.prepare('UPDATE service_items SET name_km = ? WHERE name_en = ? AND name_km IS NULL');
  for (const [, en, , , km] of MENU) fill.run(km, en);
}
