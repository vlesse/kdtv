# 播放引擎实测工装

一个单独的 APK，不参与出包，也不会装到客人的电视上。它只回答一个问题：

> 同一台机器、同一个网络、同一分钟，换一个播放内核，这些台能通多少、起播多久？

## 为什么要单独测

现在盒子上跑的是 WebView + hls.js。换成原生播放器（Media3 / IJKPlayer）
在理论上有几个好处 —— 硬解、不受跨域限制、起播快。但这几条都是"应该"，
**在你自己的机器和你自己的线路上是不是真的，只能量**。

而且量的时候有三个坑，踩了哪个结论都是假的：

1. **UA 必须三个引擎一样。** 有的上游按 User-Agent 拦人（实测 ATV3 对
   `ExoPlayerLib/1.5.1` 一律回 403，换 WebView 的 UA 就通）。UA 不统一的话，
   量到的差别是"谁的 UA 讨喜"，跟播放能力无关。
2. **判"通"的尺子必须一样。** 三个引擎都用同一条：出画面 3 秒后**播放位置
   确实往前走了**。用"播放器状态是 READY"之类各家自己的说法，比的就不是同一件事。
3. **一次只测一个引擎。** 三个引擎放在同一个进程里连着跑，第二轮开始
   Media3 会对**每一个台**报 `ERROR_CODE_DECODER_INIT_FAILED` —— 解码器
   实例被前面的引擎占光了，跟频道好不好毫无关系。这种失败长得特别像
   "这个内核不行"，实际上是工装自己造出来的。要跑多轮就一个引擎一个进程：

   ```
   for m in exo ijk web; do
     adb shell am force-stop com.wewatch.probe
     adb shell am start -n com.wewatch.probe/.ProbeActivity ... -e mode $m --ei repeat 3
     # 等它跑完，把 csv 拉出来再跑下一个（文件会被覆盖）
   done
   ```

4. **源本身死掉的台要摘出去单算。** 上游 404 的台，换哪个内核都放不了，
   混在通过率里会把结论带偏。`groundtruth.py` 先把这类挑出来。

## 用法

装：

```
adb install -r -t probe/build/outputs/apk/debug/probe-debug.apk
```

跑（线路口令走命令行传，不写死在源码里 —— 这个包会被随手装到测试机上）：

```
adb shell am start -n com.wewatch.probe/.ProbeActivity \
  -e base https://ott.example.com/stream \
  -e user LINE_USER -e pass LINE_PASS \
  -e mode exo,ijk,web --ei timeout 15000
```

`-e mode` 可选（逗号分隔，按顺序跑）：

| mode | 测的是 |
| --- | --- |
| `exo` | Media3 + HLS |
| `ijk` | IJKPlayer（FFmpeg 软硬解） |
| `web` | WebView + hls.js —— **现在盒子上跑的就是这条**，对照组 |

`--ei limit 5` 只跑前 5 个台，用来确认工装本身是通的，再跑全量。

`-e only 2,5,90` 只测指定频道号，`--ei repeat 3` 同一批跑三轮 —— 有争议的台
**必须跑多轮**：一次偶发卡顿和一条坏源，在单次结果里长得一模一样。

看结果：

```
adb logcat -s WeWatchProbe:V
adb pull /sdcard/Android/data/com.wewatch.probe/files/probe.csv
```

## 到酒店现场跑

模拟器上量出来的**通过率**可以信（那是网络和源的事），**起播时间不能信** ——
模拟器是 x86 软解，真盒子是硬解。所以换内核前，一定要在真机上再跑一遍：
盒子插网线、装这个包、跑全量、把 csv 拉出来。

`ijk` 那一档带了 armv7a / arm64 / x86 三套 so，市面上的盒子都覆盖得到。
