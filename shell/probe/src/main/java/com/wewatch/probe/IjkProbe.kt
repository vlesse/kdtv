package com.wewatch.probe

import android.os.SystemClock
import android.view.SurfaceView
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import tv.danmaku.ijk.media.player.IjkMediaPlayer
import kotlin.coroutines.resume

/**
 * 第三个内核：IJKPlayer（FFmpeg）。
 *
 * 它和 Media3 的分工很清楚：Media3 用系统解码器，认得的容器和编码就是系统认得的
 * 那些；IJK 背后是整个 FFmpeg，**系统不认的它多半也能放**，代价是软解时 CPU 高。
 * 所以真正值得量的不是「谁更快」，而是「Media3 放不了的那几个台，IJK 能不能放」。
 *
 * 依赖走的是 GSYVideoPlayer 的 jitpack 版本，因为 ijkplayer 官方包挂在
 * 已经关掉的 jcenter 上，今天根本拉不下来。GSY 那套是同一个 ijkplayer，
 * 带 FFmpeg 和 https。
 */
object IjkProbe {

    private var loadFailed: String? = null

    suspend fun probe(
        surface: SurfaceView,
        url: String,
        timeoutMs: Long,
        ua: String,
    ): ExoProbe.Outcome {
        loadFailed?.let { return ExoProbe.Outcome(false, -1, -1, false, it, "") }

        val player = try {
            IjkMediaPlayer()
        } catch (e: Throwable) {
            // 缺 .so 就整轮都测不了，记一次，后面每个台直接返回同一句，
            // 而不是 91 次都去加载一遍。
            loadFailed = "ijk load failed: ${e.message}"
            return ExoProbe.Outcome(false, -1, -1, false, loadFailed!!, "")
        }

        val t0 = SystemClock.elapsedRealtime()
        var readyMs = -1L
        var frameMs = -1L
        var error: String? = null

        try {
            player.apply {
                // 硬解优先，跟 Media3 站在同一条起跑线上；硬解不了会自动回落软解，
                // 那正是 IJK 相对 Media3 的全部价值所在。
                setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "mediacodec", 1)
                setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "mediacodec-auto-rotate", 1)
                setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "mediacodec-handle-resolution-change", 1)
                // 不开这个，https 和 302 到 http 的跳转会被 FFmpeg 的协议白名单挡掉 ——
                // 和 Media3 那边 allowCrossProtocolRedirects 是同一件事。
                setOption(
                    IjkMediaPlayer.OPT_CATEGORY_FORMAT, "protocol_whitelist",
                    "async,cache,crypto,file,http,https,tcp,tls,rtp,udp,hls,applehttp",
                )
                // 和 Media3、hls.js 用同一个 UA。有上游只认浏览器（见 ExoProbe）。
                setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "user_agent", ua)
                setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "reconnect", 1)
                setOption(IjkMediaPlayer.OPT_CATEGORY_FORMAT, "timeout", 8_000_000L)
                setOption(IjkMediaPlayer.OPT_CATEGORY_PLAYER, "framedrop", 1)
            }

            val done = withTimeoutOrNull(timeoutMs) {
                suspendCancellableCoroutine<Unit> { cont ->
                    player.setOnPreparedListener {
                        readyMs = SystemClock.elapsedRealtime() - t0
                        player.start()
                    }
                    player.setOnInfoListener { _, what, _ ->
                        if (what == IjkMediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START && frameMs < 0) {
                            frameMs = SystemClock.elapsedRealtime() - t0
                            if (cont.isActive) cont.resume(Unit)
                        }
                        true
                    }
                    player.setOnErrorListener { _, what, extra ->
                        error = "ijk error what=$what extra=$extra"
                        if (cont.isActive) cont.resume(Unit)
                        true
                    }
                    player.setSurface(surface.holder.surface)
                    player.dataSource = url
                    player.prepareAsync()
                }
            }

            if (done == null && error == null) {
                error = if (readyMs >= 0) "timeout-no-frame" else "timeout"
            }

            val codec = listOfNotNull(
                if (player.videoWidth > 0) "${player.videoWidth}x${player.videoHeight}" else null,
            ).joinToString(" ")

            if (error != null) return ExoProbe.Outcome(false, readyMs, frameMs, false, error!!, codec)

            // 和另外两个引擎同一把尺子：看播放位置有没有往前走。
            val pos0 = player.currentPosition
            delay(3_000)
            val stable = player.currentPosition > pos0 + 500
            return ExoProbe.Outcome(
                true, readyMs, frameMs, stable,
                if (stable) "" else "stalled-after-start", codec,
            )
        } finally {
            runCatching { player.release() }
        }
    }
}
