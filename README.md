# KDTV — 酒店电视系统

给酒店客房做的机顶盒电视系统：直播、点播、客房服务、按酒店分账，
一套后台管多家酒店。

盒子里装的 APK 只是一个壳，**界面和规则都在服务器上** ——
改菜单、换模板、改价格不用碰任何一台电视。

```
机顶盒 (APK) ──▶  KDTV 服务器  ──▶  XUI.one 面板  ◀── 采集器
  薄壳 WebView        │              直播、电影、剧集
                      │
                房间、订单、收款、
                多酒店隔离、界面下发
```

视频是**盒子直接找面板要**的，不经过 KDTV 服务器 —— 否则服务器带宽会变成
整个系统的瓶颈。只有元数据走服务器。

## 从哪看起

| 想知道 | 看 |
| --- | --- |
| **整个生意怎么转**：从进一台盒子到客人看电视到钱进账 | **[docs/业务流程.md](docs/业务流程.md)** ← 先看这个 |
| 怎么部署、线上是什么样、踩过哪些坑 | [deploy/DEPLOY.md](deploy/DEPLOY.md) |
| 换原生播放内核值不值 | [shell/probe/RESULTS.md](shell/probe/RESULTS.md) |
| 播放引擎实测工装怎么用 | [shell/probe/README.md](shell/probe/README.md) |

## 目录

```
bff/          服务端（Node + Fastify + SQLite）
  src/            接口、房间、订单、收款、多租户
  src/admin-ui/   后台（单文件，坐着用）
  src/desk-ui/    前台手机页（单文件，站着用）
  scripts/        自检脚本，改完必须跑
web/          电视界面（TypeScript + Vite，无框架）
shell/
  app/        安卓薄壳 APK
  probe/      播放引擎实测工装（不出包）
deploy/       Docker、nginx、部署文档
docs/         业务流程
```

影片和剧集由 `xui-collector` 从资源站采进面板 —— 面板本身发来时目录是空的。

## 为什么是这个形状

三条需求塌缩成了同一个决定：**界面是服务端下发的 web bundle，APK 只是薄壳。**

- 要能跨平台 → 界面是网页
- 要能热更新 → 服务端部署一次，全部电视下次开机就变了
- 客人不该输服务器地址 → APK 里只烧一个地址，别的全从那里取

代价是播放层受浏览器限制（少数源站不给跨域头，要绕一道中继）。
这个代价量过，结论在 [shell/probe/RESULTS.md](shell/probe/RESULTS.md)。

## 开发

```bash
# 服务端
cd bff && npm install && npm run dev

# 电视界面
cd web && npm install && npm run dev

# 改完必须跑，三个都要绿
cd bff && node scripts/selfcheck.js      # 88 项：收款、发货、防重复发货
cd bff && node scripts/tenancy-check.js  # 84 项：A 店看不看得见 B 店的东西
cd bff && node scripts/ui-check.js       #  6 项：后台/前台那两个单文件页面还能不能跑
```

第二个脚本尤其重要。多租户的错误**线上不会报错**，只会是 B 店的客人发现
电视上显示着别人家的名字，或者一家交了钱十家一起免费。只能靠主动去撞。

第三个是补一个真实的洞：`/admin/` 和 `/desk/` 是「一个 HTML 里塞一整段内联 JS」，
没有构建步骤，**发布前没有任何东西会解析它**。写错一个字符，服务端照样 200 把
文件发出去，浏览器解析到那行就整段放弃 —— 页面一片空白，而所有 curl 检查全绿。
真出过一次：少一个 `=`，后台白了很久才被发现。

## 真实地址和口令

不在这个仓库里。见本机的 `deploy/SECRETS.local.md`（不进 git）。
签名钥匙在 `<keystore 目录>/`。

**签名钥匙丢了就再也发不出能覆盖升级的包** —— 只能一个房间一个房间地
卸载重装。
