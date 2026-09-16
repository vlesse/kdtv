package com.wewatch.tv

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * 通电就出画面。
 *
 * 酒店里没有人会先拿遥控器找一个图标再按确定 —— 客人进门按电源，电视亮起来
 * 就该是台电视。所以开机自启有两条路，这里是第一条，两条都留着：
 *
 *  1. **开机广播**（这个文件）。收到 BOOT_COMPLETED 就把 MainActivity 拉起来。
 *     大部分机顶盒和 AOSP 的安卓电视都吃这一套。
 *
 *  2. **当桌面**（见 AndroidManifest 里的 CATEGORY_HOME）。装机时在系统里把
 *     本应用设成默认桌面，开机直接进来，按 Home 键也回到这里。
 *     **这条更可靠，而且顺带挡住了客人乱逛系统设置** —— 酒店真正想要的是这个。
 *
 * 为什么两条都要：Android 10 之后收紧了「后台启动 Activity」，有些固件上
 * 第一条会被静默拦掉，而且**拦掉的时候不报错**，只是什么都没发生。
 * 装机的人不会知道，直到第二天有客人说电视打不开。第二条不受这个限制。
 *
 * 这个接收器本身很轻：不做网络、不读数据库，就是把界面拉起来。开机那几十秒
 * 里网络多半还没通，这件事交给 boot() 自己去重试（见 web/src/main.ts）。
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action !in WAKE_ACTIONS) return

        val launch = Intent(context, MainActivity::class.java).apply {
            // 从广播里起 Activity 必须带 NEW_TASK —— 广播没有自己的任务栈。
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            // 开机时不该在最近任务里留下一堆历史。
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }

        try {
            context.startActivity(launch)
            Log.i(TAG, "boot autostart: launched from $action")
        } catch (e: Exception) {
            /*
             * 被固件拦下来就记一笔，不崩。
             *
             * 这条日志是装机时唯一能看出「第一条路没走通」的线索 ——
             * 没有它，现场只会看到一台开机后停在系统桌面的电视，
             * 而没人知道是哪一步没成。看到这行就去设默认桌面。
             */
            Log.w(TAG, "boot autostart blocked by the system (${Build.MANUFACTURER} ${Build.MODEL}); " +
                "set this app as the default launcher instead", e)
        }
    }

    private companion object {
        const val TAG = "WeWatchBoot"

        /**
         * 各家固件用的开机广播不止一个。
         *
         * 标准的是 BOOT_COMPLETED；但很多国产盒子为了开机快用「快速启动」，
         * 那种唤醒发的是 QUICKBOOT_POWERON 一类的私有广播，收不到标准那条。
         * 都收下，代价只是偶尔重复收到一次 —— 而 MainActivity 是 singleTask，
         * 重复拉起只是把已经在前台的它再放到前台一次。
         */
        val WAKE_ACTIONS = setOf(
            Intent.ACTION_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON",
            "android.intent.action.REBOOT",
        )
    }
}
