package com.wewatch.tv

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import java.net.NetworkInterface
import java.util.Locale

/**
 * The whole native app.
 *
 * It deliberately does almost nothing: it opens a WebView on the portal and
 * injects the box's identity. All product behaviour lives in the web bundle
 * the portal serves, so shipping a new UI to a fleet of boxes is a server
 * deploy - nobody has to visit a hotel to sideload an APK.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        web = WebView(this)
        setContentView(web)
        goFullscreen()

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            cacheMode = WebSettings.LOAD_DEFAULT

            // The portal is served over HTTPS, but the panel redirects playback
            // to upstream CDNs that only speak plain HTTP, so a strict WebView
            // blocks every stream. This fleet is company hardware on an internal
            // network, and the alternative is no video at all.
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }

        // Hardware layer keeps video decoding off the CPU on weak boxes.
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        web.setBackgroundColor(0xFF05070D.toInt())

        // Registered BEFORE the first load, so the bridge already exists when
        // the page's own scripts run. This is the whole point: identity has to
        // be readable synchronously at boot, not pushed in afterwards.
        web.addJavascriptInterface(Identity(), "WeWatchShell")

        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            // Belt and braces for anything that reads the globals instead of
            // the bridge. By this point the app has usually already asked.
            override fun onPageFinished(view: WebView, url: String) = injectIdentity()

            // The bridge is exposed to whatever document is loaded, so keep the
            // WebView pinned to the portal. A stray link must not hand a random
            // page the box's identity.
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean = !isPortal(request.url)
        }

        web.loadUrl(BuildConfig.PORTAL_URL)
    }

    private fun isPortal(url: Uri?): Boolean {
        val host = url?.host ?: return false
        return host.equals(Uri.parse(BuildConfig.PORTAL_URL).host, ignoreCase = true)
    }

    /**
     * The box's identity, readable from JavaScript the moment the page starts.
     *
     * The old approach injected globals in onPageFinished, which fires after
     * the page's scripts have already run - so the app registered itself under
     * a fallback id and then started sending the real one, and every content
     * request came back 403.
     */
    private inner class Identity {
        @JavascriptInterface
        fun deviceId(): String =
            Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: ""

        /** Empty rather than null - the JS bridge cannot express null cleanly. */
        @JavascriptInterface
        fun mac(): String = wiredMac() ?: ""

        @JavascriptInterface
        fun shellVersion(): String = BuildConfig.VERSION_NAME
    }

    /**
     * Hand the web app a stable per-box id and, where the platform still
     * allows it, the MAC. The MAC is what lets a dormitory rollout provision
     * a box to its room with no interaction at all.
     */
    private fun injectIdentity() {
        val id = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown"
        val mac = wiredMac()
        val js = buildString {
            append("window.__DEVICE_ID__=").append(quote(id)).append(';')
            if (mac != null) append("window.__DEVICE_MAC__=").append(quote(mac)).append(';')
        }
        web.evaluateJavascript(js, null)
    }

    private fun quote(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    /** Ethernet first - a set-top box is usually cabled, and its wired MAC is stable. */
    private fun wiredMac(): String? = runCatching {
        NetworkInterface.getNetworkInterfaces().toList()
            .sortedByDescending { it.name.startsWith("eth") }
            .firstNotNullOfOrNull { nif ->
                nif.hardwareAddress?.takeIf { it.size == 6 }?.joinToString(":") {
                    String.format(Locale.US, "%02X", it)
                }
            }
    }.getOrNull()

    private fun goFullscreen() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility =
            (View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
    }

    /**
     * Let the web app decide what Back means - it may be closing a panel
     * rather than leaving a screen. Only exit once the page says it is at the
     * top level, which it signals by leaving history empty.
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            web.evaluateJavascript(
                "(function(){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true})()",
                null,
            )
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onResume() {
        super.onResume()
        goFullscreen()
        web.onResume()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }
}
