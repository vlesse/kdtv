/**
 * Interface language.
 *
 * The dormitories mix Chinese management, Khmer-speaking residents and enough
 * English to cover everyone else, and the boxes were originally shipped with
 * an Indonesian interface - so all four ship, and the viewer picks. The choice
 * lives in localStorage, i.e. per box, which is what a room actually wants.
 */

export const LANGS = ['zh', 'en', 'km', 'id'] as const;
export type Lang = (typeof LANGS)[number];

export const LANG_NAMES: Record<Lang, string> = {
  zh: '中文',
  en: 'English',
  km: 'ខ្មែរ',
  id: 'Indonesia',
};

type Dict = Record<string, string>;

const zh: Dict = {
  'day.0': '星期日',
  'day.1': '星期一',
  'day.2': '星期二',
  'day.3': '星期三',
  'day.4': '星期四',
  'day.5': '星期五',
  'day.6': '星期六',
  'home.welcome': '欢迎光临',
  'home.room': '房间',
  'home.noRoom': '未分配',
  'tile.live': '电视直播',
  'tile.vod': '影视点播',
  'tile.service': '客房服务',
  'tile.about': '关于我们',
  'tile.adult': '成人频道',
  'tile.explore': '旅游周边',
  'explore.title': '旅游周边',
  'explore.empty': '这家酒店还没有填周边信息。',
  'about.title': '关于',
  'about.room': '房间',
  'about.device': '设备编号',
  'about.line': '线路状态',
  'about.version': '版本',
  'about.support': '服务电话',
  'about.active': '正常',
  'about.inactive': '未开通',
  'weather.clear': '晴',
  'weather.partly': '多云',
  'weather.cloudy': '阴',
  'weather.fog': '雾',
  'weather.rain': '雨',
  'weather.snow': '雪',
  'weather.showers': '阵雨',
  'weather.storm': '雷雨',
  'nav.home': '首页',
  'nav.live': '直播',
  'nav.vod': '影视',
  'nav.service': '客房服务',

  'boot.connecting': '连接中…',
  'boot.failed': '无法连接',
  'boot.retry': '重试',

  'activate.kicker': '设备开通',
  'activate.title': '开通码',
  'activate.hint': '请把这个号码告诉服务人员，以开通您房间的电视。',
  'activate.refresh': '刷新',

  'home.onNow': '正在播出',
  'home.watch': '立即观看',
  'home.summary': '共 {n} 个直播频道，分为 {c} 个分类。按 OK 键开始观看。',
  'home.empty': '暂无频道。',
  'home.channels': '{n} 个频道',

  'player.list': '频道列表',
  'player.lastChannel': '上一个频道',
  'player.noLast': '还没有上一个频道',
  'player.hint': '上下键换台 · 数字键直接输入频道号',
  'player.noChannel': '没有 {n} 号频道',
  'adult.title': '成人频道',
  'adult.enterPin': '请输入 PIN 码',
  'adult.checking': '验证中…',
  'adult.tooShort': 'PIN 码至少 4 位',
  'adult.wrongPin': 'PIN 码不对,还可以试 {n} 次',
  'adult.wrongPinPlain': 'PIN 码不对',
  'adult.lockedOut': '错误次数过多,请 {n} 分钟后再试',
  'adult.unavailable': '本房间未开通此板块',
  'adult.notice': '仅限成年人观看 · 离开后自动上锁',
  'adult.lock': '锁定并退出',
  'adult.empty': '此板块暂无内容',
  'player.back': '返回',
  'player.menu': '菜单',
  'menu.title': '菜单',
  'menu.channels': '频道列表',
  'menu.close': '按返回键关闭',
  'menu.watching': '正在播放',
  'player.channels': '频道',
  'player.live': '直播',
  'player.noEpg': '暂无节目信息',
  'player.connecting': '正在连接信源…',
  'player.buffering': '缓冲中…',
  'player.reconnecting': '信号中断，正在重连…',
  'player.retry': '重试',

  'toast.channelFail': '频道加载失败',
  'toast.signalFail': '该频道信号不可用',
  'toast.playFail': '播放失败',
  'toast.sourceFail': '视频源不可用',

  'vod.emptyTitle': '暂无影片',
  'vod.emptyBody': '管理员添加片源后，这里就会出现。',
  'vod.loading': '正在载入片库…',
  'vod.titles': '{n} 部',
  'vod.play': '播放',
  'vod.resume': '继续播放 {t}',
  'vod.resumeEp': '继续第 {e} 集 {t}',
  'vod.pause': '暂停',
  'vod.next': '下一集',
  'vod.episodes': '剧集（{n}）',
  'vod.series': '剧集',
  'vod.film': '电影',
  'vod.cast': '主演',
  'vod.director': '导演',
  'vod.detailFail': '详情不可用。',

  'svc.items': '{n} 项',
  'svc.clear': '清空',
  'svc.order': '立即下单',
  'svc.chosen': '已选',
  'svc.free': '免费',
  'svc.ordered': '订单 #{id} 已受理 · {total}',
  'svc.orderFail': '下单失败',
  'svc.menuFail': '菜单不可用。',

  'search.entry': '搜索',
  'search.title': '搜索影片',
  'search.placeholder': '打拼音首字母',
  'search.hint': '按片名的拼音首字母找，比如「深渊无间」打 SYWJ',
  'search.count': '找到 {n} 部',
  'search.countCapped': '找到 {n} 部，先显示前 {shown} 部 —— 多打一个字母会更准',
  'search.del': '删除',
  'search.clear': '清空',
  'search.noneTitle': '没有找到',
  'search.noneHint': '这里打的是每个字的首字母，不是全拼 —— 《小气鬼》是 XQG，不是 XIAOQIGUI。',

  'player.profile.stable': '流畅优先',
  'player.profile.balanced': '标准',
  'player.profile.low': '低延迟',

  'pay.title': '扫码支付',
  'pay.scanHint': '用手机扫描上面的二维码完成支付',
  'pay.expiresIn': '剩余',
  'pay.expired': '二维码已过期，请重新下单',
  'pay.paid': '支付成功',
  'pay.later': '稍后再付',
  'pay.noCode': '没能生成二维码，请联系前台',
  'pay.unavailable': '暂时无法支付，请联系前台',
  'pay.lockedTitle': '需要购买观看权',
  'pay.locked.vod': '点播内容需要先购买观看权。直播频道不受影响，可以照常收看。',
  'pay.locked.live': '直播频道需要先购买观看权。',
  'pay.locked.adult': '这个板块需要先购买观看权。',
  'pay.days': '{n} 天',
  'pay.orderPay': '订单 #{id} · 请扫码支付',
  'pay.orderUnpaid': '订单已受理，费用请到前台结算',
  'svc.info': '通知',

  'svc.cat.Makanan': '餐食',
  'svc.cat.Minuman': '饮品',
  'svc.cat.Layanan Kamar': '客房服务',

  'lang.title': '界面语言',
};

const en: Dict = {
  'day.0': 'Sunday',
  'day.1': 'Monday',
  'day.2': 'Tuesday',
  'day.3': 'Wednesday',
  'day.4': 'Thursday',
  'day.5': 'Friday',
  'day.6': 'Saturday',
  'home.welcome': 'Welcome!',
  'home.room': 'Room',
  'home.noRoom': 'Not assigned',
  'tile.live': 'TV Live',
  'tile.vod': 'VOD',
  'tile.service': 'Room Service',
  'tile.about': 'About Us',
  'tile.adult': 'Adult',
  'tile.explore': 'Local Explore',
  'explore.title': 'Local Explore',
  'explore.empty': 'Nothing has been added yet.',
  'about.title': 'About',
  'about.room': 'Room',
  'about.device': 'Device ID',
  'about.line': 'Line status',
  'about.version': 'Version',
  'about.support': 'Support',
  'about.active': 'Active',
  'about.inactive': 'Not activated',
  'weather.clear': 'Sunny',
  'weather.partly': 'Partly cloudy',
  'weather.cloudy': 'Cloudy',
  'weather.fog': 'Fog',
  'weather.rain': 'Rain',
  'weather.snow': 'Snow',
  'weather.showers': 'Showers',
  'weather.storm': 'Storm',
  'nav.home': 'Home',
  'nav.live': 'Live TV',
  'nav.vod': 'Movies & Series',
  'nav.service': 'Room Service',

  'boot.connecting': 'Connecting…',
  'boot.failed': 'Cannot connect',
  'boot.retry': 'Try again',

  'activate.kicker': 'Device Activation',
  'activate.title': 'Activation Code',
  'activate.hint': 'Give this code to staff to activate the TV in your room.',
  'activate.refresh': 'Refresh',

  'home.onNow': 'On Now',
  'home.watch': 'Watch Now',
  'home.summary': '{n} live channels in {c} categories. Press OK to start watching.',
  'home.empty': 'No channels yet.',
  'home.channels': '{n} channels',

  'player.list': 'Channel List',
  'player.lastChannel': 'Last channel',
  'player.noLast': 'No previous channel yet',
  'player.hint': 'Up/Down to change channel · type a channel number',
  'player.noChannel': 'No channel {n}',
  'adult.title': 'Adult',
  'adult.enterPin': 'Enter PIN',
  'adult.checking': 'Checking...',
  'adult.tooShort': 'PIN must be at least 4 digits',
  'adult.wrongPin': 'Wrong PIN, {n} attempts left',
  'adult.wrongPinPlain': 'Wrong PIN',
  'adult.lockedOut': 'Too many attempts, try again in {n} minutes',
  'adult.unavailable': 'Not enabled for this room',
  'adult.notice': 'Adults only · locks itself when you leave',
  'adult.lock': 'Lock and exit',
  'adult.empty': 'Nothing here yet',
  'player.back': 'Back',
  'player.menu': 'Menu',
  'menu.title': 'Menu',
  'menu.channels': 'Channels',
  'menu.close': 'Press Back to close',
  'menu.watching': 'Now playing',
  'player.channels': 'Channels',
  'player.live': 'LIVE',
  'player.noEpg': 'No programme info',
  'player.connecting': 'Connecting to source…',
  'player.buffering': 'Buffering…',
  'player.reconnecting': 'Signal lost, reconnecting…',
  'player.retry': 'Try again',

  'toast.channelFail': 'Could not load channels',
  'toast.signalFail': 'Channel signal unavailable',
  'toast.playFail': 'Playback failed',
  'toast.sourceFail': 'Video source unavailable',

  'vod.emptyTitle': 'No titles yet',
  'vod.emptyBody': 'The catalogue appears once an operator adds it.',
  'vod.loading': 'Loading the catalogue…',
  'vod.titles': '{n} titles',
  'vod.play': 'Play',
  'vod.resume': 'Resume {t}',
  'vod.resumeEp': 'Resume E{e} {t}',
  'vod.pause': 'Pause',
  'vod.next': 'Next Episode',
  'vod.episodes': 'Episodes ({n})',
  'vod.series': 'Series',
  'vod.film': 'Film',
  'vod.cast': 'Cast',
  'vod.director': 'Director',
  'vod.detailFail': 'Details unavailable.',

  'svc.items': '{n} items',
  'svc.clear': 'Clear',
  'svc.order': 'Order Now',
  'svc.chosen': 'Selected',
  'svc.free': 'Free',
  'svc.ordered': 'Order #{id} received · {total}',
  'svc.orderFail': 'Could not send the order',
  'svc.menuFail': 'Menu unavailable.',

  'search.entry': 'Search',
  'search.title': 'Search films',
  'search.placeholder': 'Type to search',
  'search.hint': 'Chinese titles: type the first letter of each syllable, e.g. SYWJ',
  'search.count': '{n} found',
  'search.countCapped': '{n} found, showing {shown} — type another letter to narrow it',
  'search.del': 'Delete',
  'search.clear': 'Clear',
  'search.noneTitle': 'Nothing found',
  'search.noneHint': 'For Chinese titles type initials only — XQG, not XIAOQIGUI.',

  'player.profile.stable': 'Smoothest',
  'player.profile.balanced': 'Standard',
  'player.profile.low': 'Low delay',

  'pay.title': 'Scan to pay',
  'pay.scanHint': 'Scan the code above with your phone to pay',
  'pay.expiresIn': 'Expires in',
  'pay.expired': 'This code has expired. Please order again.',
  'pay.paid': 'Payment received',
  'pay.later': 'Pay later',
  'pay.noCode': 'Could not create a payment code. Please ask the front desk.',
  'pay.unavailable': 'Payment is unavailable right now. Please ask the front desk.',
  'pay.lockedTitle': 'A viewing pass is needed',
  'pay.locked.vod': 'Films and series need a viewing pass. Live channels are unaffected.',
  'pay.locked.live': 'Live channels need a viewing pass.',
  'pay.locked.adult': 'This section needs a viewing pass.',
  'pay.days': '{n} days',
  'pay.orderPay': 'Order #{id} · scan to pay',
  'pay.orderUnpaid': 'Order received. Please settle at the front desk.',
  'svc.info': 'Notice',

  'svc.cat.Makanan': 'Food',
  'svc.cat.Minuman': 'Drinks',
  'svc.cat.Layanan Kamar': 'Room Service',

  'lang.title': 'Language',
};

// Khmer. Reviewed against common usage on Cambodian streaming apps, but a
// native speaker should still read this before a wide rollout.
const km: Dict = {
  'day.0': 'អាទិត្យ',
  'day.1': 'ច័ន្ទ',
  'day.2': 'អង្គារ',
  'day.3': 'ពុធ',
  'day.4': 'ព្រហស្បតិ៍',
  'day.5': 'សុក្រ',
  'day.6': 'សៅរ៍',
  'home.welcome': 'សូមស្វាគមន៍!',
  'home.room': 'បន្ទប់',
  'home.noRoom': 'មិនទាន់កំណត់',
  'tile.live': 'ទូរទស្សន៍ផ្ទាល់',
  'tile.vod': 'ភាពយន្ត',
  'tile.service': 'សេវាកម្មបន្ទប់',
  'tile.about': 'អំពីយើង',
  'tile.explore': 'ទីកន្លែងជុំវិញ',
  'tile.adult': 'មនុស្សពេញវ័យ',
  'about.title': 'អំពី',
  'about.room': 'បន្ទប់',
  'about.device': 'លេខឧបករណ៍',
  'about.line': 'ស្ថានភាពបណ្ដាញ',
  'about.version': 'កំណែ',
  'about.support': 'ទំនាក់ទំនង',
  'about.active': 'ដំណើរការ',
  'about.inactive': 'មិនទាន់បើក',
  'weather.clear': 'មេឃស្រឡះ',
  'weather.partly': 'មានពពកខ្លះ',
  'weather.cloudy': 'មានពពក',
  'weather.fog': 'អ័ព្ទ',
  'weather.rain': 'ភ្លៀង',
  'weather.snow': 'ព្រិល',
  'weather.showers': 'ភ្លៀងអន្ទោល',
  'weather.storm': 'ព្យុះ',
  'nav.home': 'ទំព័រដើម',
  'nav.live': 'ទូរទស្សន៍ផ្ទាល់',
  'nav.vod': 'ភាពយន្ត និងរឿងភាគ',
  'nav.service': 'សេវាកម្មបន្ទប់',

  'boot.connecting': 'កំពុងភ្ជាប់…',
  'boot.failed': 'មិនអាចភ្ជាប់បាន',
  'boot.retry': 'ព្យាយាមម្ដងទៀត',

  'activate.kicker': 'ការបើកដំណើរការឧបករណ៍',
  'activate.title': 'លេខកូដបើកដំណើរការ',
  'activate.hint': 'សូមប្រាប់លេខកូដនេះទៅបុគ្គលិក ដើម្បីបើកដំណើរការទូរទស្សន៍ក្នុងបន្ទប់របស់អ្នក។',
  'activate.refresh': 'ផ្ទុកឡើងវិញ',

  'home.onNow': 'កំពុងចាក់',
  'home.watch': 'មើលឥឡូវនេះ',
  'home.summary': 'មានប៉ុស្តិ៍ផ្ទាល់ {n} ក្នុង {c} ប្រភេទ។ ចុច OK ដើម្បីចាប់ផ្ដើមមើល។',
  'home.empty': 'មិនទាន់មានប៉ុស្តិ៍ទេ។',
  'home.channels': 'ប៉ុស្តិ៍ {n}',

  'player.list': 'បញ្ជីប៉ុស្តិ៍',
  'player.lastChannel': 'ប៉ុស្តិ៍មុន',
  'player.noLast': 'មិនទាន់មានប៉ុស្តិ៍មុនទេ',
  'player.hint': 'ឡើង/ចុះ ដើម្បីប្ដូរប៉ុស្តិ៍ · វាយលេខប៉ុស្តិ៍',
  'player.noChannel': 'គ្មានប៉ុស្តិ៍លេខ {n}',
  'adult.title': 'មនុស្សពេញវ័យ',
  'adult.enterPin': 'បញ្ចូលលេខ PIN',
  'adult.checking': 'កំពុងពិនិត្យ...',
  'adult.tooShort': 'PIN ត្រូវមានយ៉ាងតិច ៤ ខ្ទង់',
  'adult.wrongPin': 'PIN មិនត្រឹមត្រូវ នៅសល់ {n} ដង',
  'adult.wrongPinPlain': 'PIN មិនត្រឹមត្រូវ',
  'adult.lockedOut': 'ព្យាយាមច្រើនពេក សូមរង់ចាំ {n} នាទី',
  'adult.unavailable': 'មិនបានបើកសម្រាប់បន្ទប់នេះ',
  'adult.notice': 'សម្រាប់មនុស្សពេញវ័យប៉ុណ្ណោះ · ចាក់សោដោយស្វ័យប្រវត្តិ',
  'adult.lock': 'ចាក់សោ និងចាកចេញ',
  'adult.empty': 'មិនទាន់មានមាតិកាទេ',
  'player.back': 'ត្រឡប់',
  'player.menu': 'ម៉ឺនុយ',
  'menu.title': 'ម៉ឺនុយ',
  'menu.channels': 'បញ្ជីប៉ុស្តិ៍',
  'menu.close': 'ចុច ត្រឡប់ ដើម្បីបិទ',
  'menu.watching': 'កំពុងចាក់',
  'player.channels': 'ប៉ុស្តិ៍',
  'player.live': 'ផ្ទាល់',
  'player.noEpg': 'គ្មានព័ត៌មានកម្មវិធី',
  'player.connecting': 'កំពុងភ្ជាប់ទៅប្រភព…',
  'player.buffering': 'កំពុងផ្ទុក…',
  'player.reconnecting': 'បាត់សញ្ញា កំពុងភ្ជាប់ឡើងវិញ…',
  'player.retry': 'ព្យាយាមម្ដងទៀត',

  'toast.channelFail': 'មិនអាចផ្ទុកប៉ុស្តិ៍បាន',
  'toast.signalFail': 'សញ្ញាប៉ុស្តិ៍មិនអាចប្រើបាន',
  'toast.playFail': 'ការចាក់បានបរាជ័យ',
  'toast.sourceFail': 'ប្រភពវីដេអូមិនអាចប្រើបាន',

  'vod.emptyTitle': 'មិនទាន់មានភាពយន្ត',
  'vod.emptyBody': 'បញ្ជីនឹងបង្ហាញ បន្ទាប់ពីអ្នកគ្រប់គ្រងបានបញ្ចូល។',
  'vod.loading': 'កំពុងផ្ទុកបញ្ជីភាពយន្ត…',
  'vod.titles': '{n} រឿង',
  'vod.play': 'ចាក់',
  'vod.resume': 'បន្ត {t}',
  'vod.resumeEp': 'បន្តវគ្គ {e} {t}',
  'vod.pause': 'ផ្អាក',
  'vod.next': 'វគ្គបន្ទាប់',
  'vod.episodes': 'វគ្គ ({n})',
  'vod.series': 'រឿងភាគ',
  'vod.film': 'ភាពយន្ត',
  'vod.cast': 'តួសម្ដែង',
  'vod.director': 'អ្នកដឹកនាំ',
  'vod.detailFail': 'ព័ត៌មានលម្អិតមិនអាចប្រើបាន។',

  'svc.items': '{n} មុខ',
  'svc.clear': 'សម្អាត',
  'svc.order': 'កម្ម៉ង់ឥឡូវនេះ',
  'svc.chosen': 'បានជ្រើស',
  'svc.free': 'ឥតគិតថ្លៃ',
  'svc.ordered': 'ការកម្ម៉ង់ #{id} បានទទួល · {total}',
  'svc.orderFail': 'មិនអាចផ្ញើការកម្ម៉ង់បាន',
  'svc.menuFail': 'ម៉ឺនុយមិនអាចប្រើបាន។',

  'search.entry': 'ស្វែងរក',
  'search.title': 'ស្វែងរកភាពយន្ត',
  'search.placeholder': 'វាយដើម្បីស្វែងរក',
  'search.hint': 'ចំណងជើងចិន៖ វាយអក្សរដើមនៃពាង្គនីមួយៗ ឧ. SYWJ',
  'search.count': 'រកឃើញ {n}',
  'search.countCapped': 'រកឃើញ {n} បង្ហាញ {shown} — វាយបន្ថែមអក្សរ',
  'search.del': 'លុប',
  'search.clear': 'សម្អាត',
  'search.noneTitle': 'រកមិនឃើញ',
  'search.noneHint': 'សម្រាប់ចំណងជើងចិន វាយតែអក្សរដើម — XQG មិនមែន XIAOQIGUI។',

  'player.profile.stable': 'រលូនបំផុត',
  'player.profile.balanced': 'ស្តង់ដារ',
  'player.profile.low': 'ពន្យារតិច',

  'pay.title': 'ស្កេនដើម្បីបង់ប្រាក់',
  'pay.scanHint': 'ស្កេនកូដខាងលើដោយទូរសព្ទរបស់អ្នក',
  'pay.expiresIn': 'នៅសល់',
  'pay.expired': 'កូដផុតកំណត់ហើយ សូមកុម្ម៉ង់ម្ដងទៀត',
  'pay.paid': 'បង់ប្រាក់ជោគជ័យ',
  'pay.later': 'បង់ពេលក្រោយ',
  'pay.noCode': 'មិនអាចបង្កើតកូដបាន សូមទាក់ទងផ្នែកទទួលភ្ញៀវ',
  'pay.unavailable': 'មិនអាចបង់ប្រាក់បានឥឡូវនេះ សូមទាក់ទងផ្នែកទទួលភ្ញៀវ',
  'pay.lockedTitle': 'ត្រូវការសិទ្ធិមើល',
  'pay.locked.vod': 'ខ្សែភាពយន្តត្រូវការសិទ្ធិមើល។ ប៉ុស្តិ៍ផ្សាយផ្ទាល់នៅដដែល។',
  'pay.locked.live': 'ប៉ុស្តិ៍ផ្សាយផ្ទាល់ត្រូវការសិទ្ធិមើល។',
  'pay.locked.adult': 'ផ្នែកនេះត្រូវការសិទ្ធិមើល។',
  'pay.days': '{n} ថ្ងៃ',
  'pay.orderPay': 'ការកុម្ម៉ង់ #{id} · ស្កេនដើម្បីបង់',
  'pay.orderUnpaid': 'បានទទួលការកុម្ម៉ង់ សូមបង់នៅផ្នែកទទួលភ្ញៀវ',
  'svc.info': 'ព័ត៌មាន',

  'svc.cat.Makanan': 'អាហារ',
  'svc.cat.Minuman': 'ភេសជ្ជៈ',
  'svc.cat.Layanan Kamar': 'សេវាកម្មបន្ទប់',

  'lang.title': 'ភាសា',
};

const id: Dict = {
  'day.0': 'Minggu',
  'day.1': 'Senin',
  'day.2': 'Selasa',
  'day.3': 'Rabu',
  'day.4': 'Kamis',
  'day.5': 'Jumat',
  'day.6': 'Sabtu',
  'home.welcome': 'Selamat datang!',
  'home.room': 'Kamar',
  'home.noRoom': 'Belum ditetapkan',
  'tile.live': 'TV Langsung',
  'tile.vod': 'Film & Serial',
  'tile.service': 'Layanan Kamar',
  'tile.about': 'Tentang kami',
  'tile.explore': 'Wisata Sekitar',
  'tile.adult': 'Dewasa',
  'about.title': 'Tentang',
  'about.room': 'Kamar',
  'about.device': 'ID Perangkat',
  'about.line': 'Status jalur',
  'about.version': 'Versi',
  'about.support': 'Bantuan',
  'about.active': 'Aktif',
  'about.inactive': 'Belum aktif',
  'weather.clear': 'Cerah',
  'weather.partly': 'Berawan sebagian',
  'weather.cloudy': 'Berawan',
  'weather.fog': 'Kabut',
  'weather.rain': 'Hujan',
  'weather.snow': 'Salju',
  'weather.showers': 'Hujan lokal',
  'weather.storm': 'Badai',
  'nav.home': 'Beranda',
  'nav.live': 'TV Langsung',
  'nav.vod': 'Film & Serial',
  'nav.service': 'Layanan Kamar',

  'boot.connecting': 'Menghubungkan…',
  'boot.failed': 'Tidak dapat terhubung',
  'boot.retry': 'Coba lagi',

  'activate.kicker': 'Aktivasi Perangkat',
  'activate.title': 'Kode Aktivasi',
  'activate.hint': 'Berikan kode ini kepada petugas untuk mengaktifkan TV di kamar Anda.',
  'activate.refresh': 'Segarkan',

  'home.onNow': 'Sedang Tayang',
  'home.watch': 'Tonton Sekarang',
  'home.summary': '{n} saluran langsung tersedia di {c} kategori. Tekan OK untuk mulai menonton.',
  'home.empty': 'Belum ada saluran.',
  'home.channels': '{n} saluran',

  'player.list': 'Daftar Saluran',
  'player.lastChannel': 'Saluran sebelumnya',
  'player.noLast': 'Belum ada saluran sebelumnya',
  'player.hint': 'Atas/Bawah ganti saluran · ketik nomor saluran',
  'player.noChannel': 'Saluran {n} tidak ada',
  'adult.title': 'Dewasa',
  'adult.enterPin': 'Masukkan PIN',
  'adult.checking': 'Memeriksa...',
  'adult.tooShort': 'PIN minimal 4 angka',
  'adult.wrongPin': 'PIN salah, sisa {n} percobaan',
  'adult.wrongPinPlain': 'PIN salah',
  'adult.lockedOut': 'Terlalu sering salah, coba lagi {n} menit',
  'adult.unavailable': 'Tidak aktif untuk kamar ini',
  'adult.notice': 'Khusus dewasa · terkunci otomatis saat keluar',
  'adult.lock': 'Kunci dan keluar',
  'adult.empty': 'Belum ada konten',
  'player.back': 'Kembali',
  'player.menu': 'Menu',
  'menu.title': 'Menu',
  'menu.channels': 'Daftar saluran',
  'menu.close': 'Tekan Kembali untuk menutup',
  'menu.watching': 'Sedang diputar',
  'player.channels': 'Saluran',
  'player.live': 'LIVE',
  'player.noEpg': 'Tidak ada info',
  'player.connecting': 'Menghubungkan ke sumber…',
  'player.buffering': 'Memuat…',

  'toast.channelFail': 'Gagal memuat saluran',
  'toast.signalFail': 'Sinyal saluran tidak tersedia',
  'toast.playFail': 'Gagal memutar',
  'toast.sourceFail': 'Sumber video tidak tersedia',

  'vod.emptyTitle': 'Belum ada film',
  'vod.emptyBody': 'Katalog akan muncul setelah pengelola menambahkannya.',
  'vod.loading': 'Memuat katalog…',
  'vod.titles': '{n} judul',
  'vod.play': 'Putar',
  'vod.resume': 'Lanjutkan {t}',
  'vod.resumeEp': 'Lanjutkan E{e} {t}',
  'vod.pause': 'Jeda',
  'vod.next': 'Episode Berikutnya',
  'vod.episodes': 'Episode ({n})',
  'vod.series': 'Serial',
  'vod.film': 'Film',
  'vod.cast': 'Pemeran',
  'vod.director': 'Sutradara',
  'vod.detailFail': 'Detail tidak tersedia.',

  'svc.items': '{n} item',
  'svc.clear': 'Kosongkan',
  'svc.order': 'Pesan Sekarang',
  'svc.chosen': 'Dipilih',
  'svc.free': 'Gratis',
  'svc.ordered': 'Pesanan #{id} diterima · {total}',
  'svc.orderFail': 'Gagal mengirim pesanan',
  'svc.menuFail': 'Menu tidak tersedia.',

  'search.entry': 'Cari',
  'search.title': 'Cari film',
  'search.placeholder': 'Ketik untuk mencari',
  'search.hint': 'Judul Mandarin: ketik huruf awal tiap suku kata, mis. SYWJ',
  'search.count': '{n} ditemukan',
  'search.countCapped': '{n} ditemukan, tampil {shown} — ketik huruf lagi',
  'search.del': 'Hapus',
  'search.clear': 'Bersihkan',
  'search.noneTitle': 'Tidak ditemukan',
  'search.noneHint': 'Untuk judul Mandarin ketik huruf awal saja — XQG, bukan XIAOQIGUI.',

  'player.profile.stable': 'Paling lancar',
  'player.profile.balanced': 'Standar',
  'player.profile.low': 'Delay rendah',

  'pay.title': 'Pindai untuk bayar',
  'pay.scanHint': 'Pindai kode di atas dengan ponsel Anda',
  'pay.expiresIn': 'Sisa waktu',
  'pay.expired': 'Kode sudah kedaluwarsa, silakan pesan lagi',
  'pay.paid': 'Pembayaran diterima',
  'pay.later': 'Bayar nanti',
  'pay.noCode': 'Gagal membuat kode. Silakan hubungi resepsionis.',
  'pay.unavailable': 'Pembayaran belum tersedia. Silakan hubungi resepsionis.',
  'pay.lockedTitle': 'Perlu paket menonton',
  'pay.locked.vod': 'Film dan serial perlu paket menonton. Siaran langsung tetap bisa ditonton.',
  'pay.locked.live': 'Siaran langsung perlu paket menonton.',
  'pay.locked.adult': 'Bagian ini perlu paket menonton.',
  'pay.days': '{n} hari',
  'pay.orderPay': 'Pesanan #{id} · pindai untuk bayar',
  'pay.orderUnpaid': 'Pesanan diterima. Silakan bayar di resepsionis.',
  'svc.info': 'Informasi',

  'svc.cat.Makanan': 'Makanan',
  'svc.cat.Minuman': 'Minuman',
  'svc.cat.Layanan Kamar': 'Layanan Kamar',

  'lang.title': 'Bahasa',
};

const DICTS: Record<Lang, Dict> = { zh, en, km, id };

const KEY = 'ott.lang';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && (LANGS as readonly string[]).includes(saved)) return saved as Lang;
  } catch {
    /* fall through to the box's own locale */
  }

  const tag = (navigator.language || '').toLowerCase();
  if (tag.startsWith('zh')) return 'zh';
  if (tag.startsWith('km')) return 'km';
  if (tag.startsWith('id') || tag.startsWith('in')) return 'id';
  if (tag.startsWith('en')) return 'en';

  // Chinese management, so an unknown box is more likely to want 中文 than
  // anything else.
  return 'zh';
}

let current: Lang = detect();

export const lang = (): Lang => current;

export function setLang(next: Lang) {
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* the choice just will not survive a reboot */
  }
  document.documentElement.lang = next;
}

/** Look up a string, filling {placeholders}. Falls back to English, then the key. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const raw = DICTS[current][key] ?? DICTS.en[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

/**
 * Pick the best available translation of a name the server sent, e.g. a menu
 * item. Falls through the other languages rather than showing nothing.
 */
/**
 * 按**指定**语言取一条文案，不看当前选的是什么。
 *
 * 底部导航条一格里有两行：上面永远是英文，下面是客人选的那种语言。
 * 英文当标题是因为它是这类场所唯一人人认得出的那一行 —— 图标之外的第二条线索。
 */
export function tIn(l: Lang, key: string): string {
  return DICTS[l]?.[key] ?? DICTS.en[key] ?? key;
}

export function pick(names: Partial<Record<Lang, string | null>>): string {
  const order: Lang[] = [current, 'en', 'id', 'zh', 'km'];
  for (const l of order) {
    const v = names[l];
    if (v) return v;
  }
  return '';
}

document.documentElement.lang = current;
