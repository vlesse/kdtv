package com.wewatch.probe

import android.content.Context
import android.os.SystemClock
import android.view.SurfaceView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * 用 Media3（ExoPlayer）放一个台，量它多久出画面。
 *
 * 量三个时间点，因为它们坏起来是三件不同的事：
 *   ready  拿到播放列表、缓冲够了。慢在这里 = 网络或上游服务器慢。
 *   frame  第一帧真的画到屏幕上。ready 到 frame 之间慢 = 盒子解码慢。
 *   stable 出画面 3 秒后还在播。**这一条才是「能看」** ——
 *          有的源能起播然后立刻断，只量起播会把它算成成功。
 */
object ExoProbe {

    /**
     * 两件事都不能省：跨协议跳转，和一个像浏览器的 User-Agent。
     *
     * **跨协议跳转**：面板给的是 https 地址，但它 302 到只有明文 http 的上游 CDN。
     * ExoPlayer 默认拒绝降级跳转（这个默认是对的），于是每一个台都失败，
     * 报的还是一个看不出所以然的 source 错误。
     *
     * **UA**：有的上游只认浏览器。实测 ATV3 对 `ExoPlayerLib/1.5.1` 和自定义 UA
     * 一律回 403，换成 WebView 的 UA 就正常 —— 也就是说，一个原生播放器如果
     * 用自己的默认 UA，会平白丢掉现在 WebView 放得好好的台。**这不是网络问题，
     * 是换内核时最容易漏掉的一脚**，所以 UA 从外面传进来，和对照组用同一个。
     */
    private fun httpFactory(ua: String) = DefaultHttpDataSource.Factory()
        .setAllowCrossProtocolRedirects(true)
        .setUserAgent(ua)
        .setConnectTimeoutMs(8_000)
        .setReadTimeoutMs(8_000)

    suspend fun probe(
        ctx: Context,
        surface: SurfaceView,
        url: String,
        timeoutMs: Long,
        ua: String,
    ): Outcome {
        val player = ExoPlayer.Builder(ctx)
            .setMediaSourceFactory(DefaultMediaSourceFactory(httpFactory(ua)))
            .build()

        val t0 = SystemClock.elapsedRealtime()
        var readyMs = -1L
        var frameMs = -1L
        var error: String? = null

        try {
            player.setVideoSurfaceView(surface)
            player.volume = 0f

            val done = suspendWithTimeout(timeoutMs) { cont ->
                val listener = object : Player.Listener {
                    override fun onPlaybackStateChanged(state: Int) {
                        if (state == Player.STATE_READY && readyMs < 0) {
                            readyMs = SystemClock.elapsedRealtime() - t0
                        }
                    }

                    override fun onRenderedFirstFrame() {
                        if (frameMs < 0) frameMs = SystemClock.elapsedRealtime() - t0
                        if (cont.isActive) cont.resume(Unit)
                    }

                    override fun onPlayerError(e: PlaybackException) {
                        error = "${e.errorCodeName}: ${rootCause(e)}"
                        if (cont.isActive) cont.resume(Unit)
                    }
                }
                player.addListener(listener)
                player.setMediaItem(MediaItem.fromUri(url))
                player.prepare()
                player.playWhenReady = true
                cont.invokeOnCancellation { player.removeListener(listener) }
            }

            if (done == null && error == null) {
                // 超时。ready 到了却没有画面，多半是纯音频或者解不了的视频编码 ——
                // 这两种在报告里要分得开，所以把 ready 的时间留着。
                error = if (readyMs >= 0) "timeout-no-frame" else "timeout"
            }

            val video = player.videoFormat
            val codec = listOfNotNull(
                video?.sampleMimeType?.removePrefix("video/"),
                video?.let { if (it.width > 0) "${it.width}x${it.height}" else null },
                player.audioFormat?.sampleMimeType?.removePrefix("audio/"),
            ).joinToString(" ")

            if (error != null) return Outcome(false, readyMs, frameMs, false, error!!, codec)

            /*
             * 出画面之后再看 3 秒，看**播放位置有没有真的往前走**。
             *
             * 判据要和 hls.js 那边一模一样（那边看的是 video.currentTime），
             * 否则比的就不是引擎了。一开始我这里写的是「状态还是 READY 且
             * isPlaying」，结果在模拟器上软解 1080p 时大量频道被判成不稳 ——
             * 那是缓冲跟不上，不是源坏了，而 hls.js 那边不会被这么判。
             * 两个引擎用两把尺子，比出来的东西没有意义。
             */
            val pos0 = player.currentPosition
            delay(3_000)
            val moved = player.currentPosition > pos0 + 500
            val stable = moved && player.playerError == null
            val why = player.playerError?.errorCodeName
                ?: if (!stable) "stalled-after-start" else ""
            return Outcome(true, readyMs, frameMs, stable, why, codec)
        } finally {
            player.release()
        }
    }

    /** PlaybackException 的顶层消息常常是空话，真正有用的在最里层。 */
    private fun rootCause(e: Throwable): String {
        var c: Throwable = e
        while (c.cause != null && c.cause !== c) c = c.cause!!
        return (c.message ?: c.javaClass.simpleName).take(120)
    }

    private suspend fun suspendWithTimeout(
        ms: Long,
        block: (CancellableContinuation<Unit>) -> Unit,
    ): Unit? = withTimeoutOrNull(ms) { suspendCancellableCoroutine { cont -> block(cont) } }

    data class Outcome(
        val started: Boolean,
        val readyMs: Long,
        val frameMs: Long,
        val stable: Boolean,
        val detail: String,
        val codec: String,
    )
}
