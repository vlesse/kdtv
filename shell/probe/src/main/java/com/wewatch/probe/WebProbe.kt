package com.wewatch.probe

import android.annotation.SuppressLint
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import kotlin.coroutines.resume

/**
 * 对照组：现在装在盒子上的那一套 —— WebView + hls.js。
 *
 * WebView 的设置和正式 App 一模一样（`MainActivity` 里那几行），页面从
 * assets 里以 https 的形式加载，所以跨域行为和线上一致。**这一点很要紧**：
 * 如果拿 file:// 加载，源是 null，几乎所有上游都会被跨域挡掉，
 * 量出来的失败率会比真实情况高得多，而且是假的。
 */
class WebProbe(private val web: WebView) {

    private var pending: CancellableContinuation<String>? = null
    private var loaded: CancellableContinuation<Unit>? = null

    @SuppressLint("SetJavaScriptEnabled")
    fun install() {
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(web.context))
            .build()

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        web.addJavascriptInterface(Bridge(), "Bridge")
        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)

            override fun onPageFinished(view: WebView, url: String) {
                loaded?.takeIf { it.isActive }?.resume(Unit)
                loaded = null
            }
        }
    }

    suspend fun open() = suspendCancellableCoroutine<Unit> { cont ->
        loaded = cont
        web.loadUrl("https://appassets.androidplatform.net/assets/probe.html")
    }

    suspend fun probe(url: String, timeoutMs: Long): ExoProbe.Outcome {
        val json = suspendCancellableCoroutine<String> { cont ->
            pending = cont
            val js = "window.__probe(${quote(url)}, $timeoutMs)"
            web.evaluateJavascript(js, null)
        }
        val o = JSONObject(json)
        return ExoProbe.Outcome(
            started = o.optBoolean("started"),
            readyMs = o.optLong("readyMs", -1),
            frameMs = o.optLong("frameMs", -1),
            stable = o.optBoolean("stable"),
            detail = o.optString("detail"),
            codec = o.optString("codec"),
        )
    }

    private inner class Bridge {
        @JavascriptInterface
        fun done(json: String) {
            val c = pending ?: return
            pending = null
            // 回调在 JS 线程上，而后面的 evaluateJavascript 必须回到主线程。
            web.post { if (c.isActive) c.resume(json) }
        }
    }

    private fun quote(s: String) = JSONObject.quote(s)
}
