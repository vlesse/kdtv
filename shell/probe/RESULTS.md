# 播放引擎实测结果

2026-09-15，安卓电视模拟器（AOSP TV x86，解码器 `c2.goldfish.h264.decoder`），
线路 `<LINE_USER>`，91 个直播频道。每个引擎**各自独立进程**跑一遍全量，
凡是出现过不通的台，再按引擎单独跑三轮复测，以复测结果为准。
工装和用法见 [README.md](README.md)。

## 一句话结论

**换原生内核的收益是真的，但不在「能放的台更多」上，而在起播速度和三个
浏览器根本取不到的台上。**

## 通过率（87 个还活着的源）

| 引擎 | 通 | 起播后停住 | 放不出来 | 起播中位数 | P90 |
|---|---|---|---|---|---|
| Media3 | 84/87 | 2 | 1 | 1952ms | 3016ms |
| IJKPlayer | 84/87 | 2 | 1 | 2675ms | 4422ms |
| hls.js（现役） | 82/87 | 0 | 5 | 5368ms | 8091ms |

起播时间量的是**第一帧真的画到屏幕上**，不是「开始加载」。

两个原生引擎放不出来的只有 90 CCTV5+（源已死，见下），起播后停住的是
5 ATV3 和 64 Korea TV（源本身不稳，三轮都一样）。hls.js 除了这些，
还多丢三个：5、76、91 —— 原因不是它不会放，是**浏览器根本取不到**。

## 三件结构性的事

### 1. 四个台浏览器取不到，原生随手就能放

| 台 | 名字 | 播放列表 CORS | 分片 CORS |
|---|---|---|---|
| 5 | ATV3 | （无） | （无） |
| 76 | Phoenix Infonews | （无） | （无） |
| 90 | CCTV5+ | （无） | `URLError` |
| 91 | CCTV5 | （无） | （无） |

**播放列表有 CORS 头，不代表分片也有** —— 浏览器两样都要，原生播放器两样都不看。
只查播放列表会漏掉一半情况，所以这张表是两层分开查的。

其中 90 本来就是死源，所以实际能捡回来的是 **76 Phoenix Infonews、91 CCTV5
两个整台，外加 5 ATV3 这个半通的台**。它们今天能看，是因为绕了服务器中继
（`relay.js`），也就是说**这几个台的流量全部压在我们自己的 VPS 上**。
CCTV5 是体育台，酒店里同时看的人最多 —— 20 个房间就是 60Mbps。
**这是换原生内核唯一算得出账的那笔收益。**

### 2. 八个台是源的问题，换什么内核都没用

- **24 DW English** —— 面板 302 过去直接 404
- **31 Nickelodeon** —— 面板 302 过去直接 404
- **32 PNN** —— 面板 302 过去直接 404
- **61 Afnmovie** —— 面板 302 过去直接 404
- **90 CCTV5+** —— 播放列表给得出来，但分片服务器 `<上游分片服务器>` 连不上
  （超时）。三个引擎全军覆没，curl 也拉不动。这种「半死」最坑：
  面板里看着是好的。
- **5 ATV3**、**64 Korea TV** —— 两个原生引擎各跑三轮都是起播后就停住。

**先修这八个台，比换播放内核划算得多。**

### 3. 原生播放器必须伪装成浏览器

ATV3 的上游按 User-Agent 拦人：`ExoPlayerLib/1.5.1` 和任何自定义 UA 一律 403，
换成 WebView 的 UA 就通。**一个原生播放器如果用自己的默认 UA，会平白丢掉
现在放得好好的台**，报的还是 403，现场根本看不出是 UA 的事。

同一类的还有一条：Media3 默认拒绝 https→http 的降级跳转，而面板正是这么跳的。
不开 `setAllowCrossProtocolRedirects(true)`，**每一个台都失败**。

这两条都是换内核时最容易漏、漏了之后最难查的。

## 这份数据不能用来做什么

模拟器是 x86，用的是 `c2.goldfish.h264.decoder`，不是真盒子的硬解。所以：

- **通过率可以信** —— 那是网络和源的事，跟解码器无关。
- **起播时间只能信方向，不能信数值** —— 「原生更快」每一轮都成立，
  但「快 3.4 秒」这个数在真盒子上多半不是这个数。真要拿它做决定，
  得插网线在真盒子上重跑一遍。
- 第一次跑全量时我把三个引擎放在同一个进程里连着跑，第二轮开始 Media3 对
  **每一个台**都报 `ERROR_CODE_DECODER_INIT_FAILED` —— 解码器实例被前面的引擎
  占光了，跟频道好坏毫无关系。这种失败长得特别像「这个内核不行」。
  现在的数据是一个引擎一个进程重跑的。

## 逐台明细

OK=通　UN=起播后停住　FA=放不出来

| 台 | 名字 | Media3 | IJK | hls.js | 备注 |
|---|---|---|---|---|---|
| 1 | AXN | OK | OK | OK |  |
| 2 | CCTV5 | OK | OK | OK |  |
| 3 | CCTV1 | OK | OK | OK |  |
| 4 | CCTV2 | OK | OK | OK |  |
| 5 | ATV3 | UN | UN | FA | 无 CORS |
| 6 | CCTV4 | OK | OK | OK |  |
| 7 | CCTV6 | OK | OK | OK |  |
| 8 | CCTV10 | OK | OK | OK |  |
| 9 | CCTV11 | OK | OK | OK |  |
| 10 | CCTV13 | OK | OK | OK |  |
| 11 | 云南卫视 | OK | OK | OK |  |
| 12 | 江苏卫视 | OK | OK | OK |  |
| 13 | 四川卫视 | OK | OK | OK |  |
| 14 | ANTV | OK | OK | OK |  |
| 15 | 福建东南卫视 | OK | OK | OK |  |
| 16 | 东方卫视 | OK | OK | OK |  |
| 17 | SKY Sports | OK | OK | OK |  |
| 18 | CHC | OK | OK | OK |  |
| 19 | Animax Asia | OK | OK | OK |  |
| 20 | CNN | OK | OK | OK |  |
| 21 | 深圳卫视 | OK | OK | OK |  |
| 22 | BBC Cbeebies | OK | OK | OK |  |
| 23 | 广东卫视 | OK | OK | OK |  |
| 24 | DW English | FA | FA | FA | 源 404 |
| 25 | PBS Kids | OK | OK | OK |  |
| 26 | Al Jazeera English | OK | OK | OK |  |
| 27 | KBS 1 | OK | OK | OK |  |
| 28 | Disney HD | OK | OK | OK |  |
| 29 | TV9 | OK | OK | OK |  |
| 30 | TVK | OK | OK | OK |  |
| 31 | Nickelodeon | FA | FA | FA | 源 404 |
| 32 | PNN | FA | FA | FA | 源 404 |
| 33 | TOWN TV | OK | OK | OK |  |
| 34 | MSJ TV | OK | OK | OK |  |
| 35 | Apsara TV11 | OK | OK | OK |  |
| 36 | Bayon HD TV | OK | OK | OK |  |
| 37 | TVK2 | OK | OK | OK |  |
| 38 | HBO | OK | OK | OK |  |
| 39 | NHK World | OK | OK | OK |  |
| 40 | 浙江卫视 | OK | OK | OK |  |
| 41 | CCTV12 | OK | OK | OK |  |
| 42 | CCTV14 | OK | OK | OK |  |
| 43 | CCTV15 | OK | OK | OK |  |
| 44 | HI MOVIE | OK | OK | OK |  |
| 45 | cctv7 | OK | OK | OK |  |
| 46 | CCTV3 | OK | OK | OK |  |
| 47 | CCTV9 | OK | OK | OK |  |
| 48 | KPlus | OK | OK | OK |  |
| 49 | TVB 1 | OK | OK | OK |  |
| 50 | CCTV17 | OK | OK | OK |  |
| 51 | Moinfo TV | OK | OK | OK |  |
| 52 | CNC | OK | OK | OK |  |
| 53 | astro Supersport | OK | OK | OK |  |
| 54 | VTV4 | OK | OK | OK |  |
| 55 | CTN | OK | OK | OK |  |
| 56 | CCTV8 | OK | OK | OK |  |
| 57 | SkyNet Sport HD1 | OK | OK | OK |  |
| 58 | Showcase Movies | OK | OK | OK |  |
| 59 | CDTV-TVK | OK | OK | OK |  |
| 60 | CMC TV | OK | OK | OK |  |
| 61 | Afnmovie | FA | FA | FA | 源 404 |
| 62 | BTV NEWS | OK | OK | OK |  |
| 63 | RedBull TV | OK | OK | OK |  |
| 64 | Korea TV | UN | UN | FA |  |
| 65 | RT news | OK | OK | OK |  |
| 66 | LMIC | OK | OK | OK |  |
| 67 | Phoenix Chinese | OK | OK | OK |  |
| 68 | ESPN2 | OK | OK | OK |  |
| 69 | HM HDTV | OK | OK | OK |  |
| 70 | RHM HDTV | OK | OK | OK |  |
| 71 | France 24 | OK | OK | OK |  |
| 72 | Golden Eagle Cartoon | OK | OK | OK |  |
| 73 | SBS Korea | OK | OK | OK |  |
| 74 | HI CAMBO | OK | OK | OK |  |
| 75 | Wonder | OK | OK | OK |  |
| 76 | Phoenix Infonews | OK | OK | FA | 无 CORS |
| 77 | CTV8 | OK | OK | OK |  |
| 78 | 三沙卫视 | OK | OK | OK |  |
| 79 | CNA | OK | OK | OK |  |
| 80 | 湖南卫视 | OK | OK | OK |  |
| 81 | NFL | OK | OK | OK |  |
| 82 | MYTV | OK | OK | OK |  |
| 83 | DreamWork | OK | OK | OK |  |
| 84 | CGTN Documentary | OK | OK | OK |  |
| 85 | CGTN News | OK | OK | OK |  |
| 86 | ANTV | OK | OK | OK |  |
| 87 | 山东卫视 | OK | OK | OK |  |
| 88 | BT Sports 1 | OK | OK | OK |  |
| 89 | CN卡通 | OK | OK | OK |  |
| 90 | CCTV5+ | FA | FA | FA | 无 CORS、分片服务器连不上 |
| 91 | CCTV5 | OK | OK | FA | 无 CORS |
