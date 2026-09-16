package com.wewatch.probe

import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.SurfaceView
import android.view.ViewGroup
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 播放引擎实测。
 *
 * 用法（不用改代码，地址和线路都从命令行传）：
 *
 *   adb shell am start -n com.wewatch.probe/.ProbeActivity \
 *     -e base https://ott.example.com/stream -e user X -e pass Y \
 *     -e mode exo,exots,web --ei timeout 15000
 *
 * 线路口令走 Intent 传进来而不是写死在源码里 —— 这个包会被随手装到测试机上，
 * 源码也会进仓库，口令不该跟着走。
 *
 * 三种模式测的是三条不同的路：
 *   exo    Media3 + HLS（.m3u8）—— 换内核之后最可能走的那条
 *   exots  Media3 + 裸 TS（.ts）—— 面板直出的流，没有播放列表这一层
 *   ijk    IJKPlayer（FFmpeg）—— 系统解码器不认的容器/编码，指望它
 *   web    WebView + hls.js —— **现在盒子上跑的就是这条**，对照组
 */
class ProbeActivity : AppCompatActivity() {

    private lateinit var surface: SurfaceView
    private lateinit var web: WebView
    private lateinit var status: TextView

    private data class Channel(val num: Int, val id: String, val name: String)
    private data class Row(val engine: String, val ch: Channel, val o: ExoProbe.Outcome)

    private val rows = mutableListOf<Row>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = FrameLayout(this)
        surface = SurfaceView(this)
        web = WebView(this)
        status = TextView(this).apply {
            setBackgroundColor(0xCC000000.toInt())
            setTextColor(Color.WHITE)
            textSize = 13f
            setPadding(24, 24, 24, 24)
        }
        val full = ViewGroup.LayoutParams.MATCH_PARENT
        root.addView(surface, FrameLayout.LayoutParams(full, full))
        root.addView(web, FrameLayout.LayoutParams(full, full))
        root.addView(
            status,
            FrameLayout.LayoutParams(full, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP),
        )
        setContentView(root)

        val base = intent.getStringExtra("base")?.trimEnd('/') ?: DEFAULT_BASE
        val user = intent.getStringExtra("user") ?: ""
        val pass = intent.getStringExtra("pass") ?: ""
        val modes = (intent.getStringExtra("mode") ?: "exo,web").split(',').map { it.trim() }
        val timeout = intent.getIntExtra("timeout", 15_000).toLong()
        val limit = intent.getIntExtra("limit", 0)
        // 只测指定的几个台（频道号，逗号分隔），并且可以重复若干轮。
        // 有争议的台单测一次说明不了问题 —— 一次偶发卡顿和一条坏源长得一模一样。
        val only = (intent.getStringExtra("only") ?: "")
            .split(',').mapNotNull { it.trim().toIntOrNull() }.toSet()
        val repeat = intent.getIntExtra("repeat", 1)

        lifecycleScope.launch { run(base, user, pass, modes, timeout, limit, only, repeat) }
    }

    private suspend fun run(
        base: String,
        user: String,
        pass: String,
        modes: List<String>,
        timeout: Long,
        limit: Int,
        only: Set<Int>,
        repeat: Int,
    ) {
        say("取频道表…")
        val all = runCatching { withContext(Dispatchers.IO) { fetchChannels(base, user, pass) } }
            .getOrElse {
                say("取频道表失败：${it.message}")
                Log.e(TAG, "channel list failed", it)
                return
            }
        val picked = if (only.isEmpty()) all else all.filter { it.num in only }
        val channels = if (limit > 0) picked.take(limit) else picked
        /*
         * 三个引擎共用 WebView 的 UA。
         *
         * 不这样的话比的就不是内核了 —— 有上游按 UA 拦人（ATV3 对非浏览器 UA
         * 一律 403），换个 UA 通过率就变，而那跟播放能力毫无关系。
         */
        val ua = WebSettings.getDefaultUserAgent(this)
        Log.i(TAG, "ua=$ua")
        say("${channels.size} 个台 × ${modes.size} 种引擎")
        Log.i(TAG, "=== probe start: ${channels.size} channels, modes=$modes, timeout=${timeout}ms ===")

        val probe = WebProbe(web)
        if ("web" in modes) {
            probe.install()
            probe.open()
        }

        for (round in 1..repeat) for (mode in modes) {
            web.visibility = if (mode == "web") android.view.View.VISIBLE else android.view.View.GONE
            for ((i, ch) in channels.withIndex()) {
                val ext = if (mode == "exots") "ts" else "m3u8"
                val url = "$base/live/$user/$pass/${ch.id}.$ext"
                say("[$mode] ${i + 1}/${channels.size}  ${ch.num} ${ch.name}")

                val o = runCatching {
                    when (mode) {
                        "web" -> probe.probe(url, timeout)
                        "ijk" -> IjkProbe.probe(surface, url, timeout, ua)
                        else -> ExoProbe.probe(this, surface, url, timeout, ua)
                    }
                }.getOrElse { e ->
                    ExoProbe.Outcome(false, -1, -1, false, "harness: ${e.message}", "")
                }

                val tag = if (repeat > 1) "$mode#$round" else mode
                rows += Row(tag, ch, o)
                Log.i(
                    TAG,
                    "$tag\t${ch.num}\t${ch.name}\t${verdict(o)}\tready=${o.readyMs}\tframe=${o.frameMs}\t${o.codec}\t${o.detail}",
                )
            }
        }

        report()
    }

    private fun verdict(o: ExoProbe.Outcome) =
        if (o.started && o.stable) "OK" else if (o.started) "UNSTABLE" else "FAIL"

    /**
     * 报告落盘，不只打日志。
     *
     * 到现场测的人未必会看 logcat，而 91×3 行在屏幕上也翻不过来。
     * CSV 直接 adb pull 出来就能排序看。
     */
    private fun report() {
        val dir = getExternalFilesDir(null) ?: filesDir
        val csv = File(dir, "probe.csv")
        csv.printWriter().use { w ->
            w.println("engine,num,id,name,verdict,ready_ms,frame_ms,codec,detail")
            for (r in rows) {
                w.println(
                    listOf(
                        r.engine, r.ch.num, r.ch.id, r.ch.name, verdict(r.o),
                        r.o.readyMs, r.o.frameMs, r.o.codec, r.o.detail,
                    ).joinToString(",") { csvCell(it.toString()) },
                )
            }
        }

        val lines = mutableListOf<String>()
        for (mode in rows.map { it.engine }.distinct()) {
            val m = rows.filter { it.engine == mode }
            val ok = m.count { it.o.started && it.o.stable }
            val frames = m.filter { it.o.frameMs > 0 }.map { it.o.frameMs }.sorted()
            val median = if (frames.isEmpty()) -1 else frames[frames.size / 2]
            lines += "$mode: 通 $ok/${m.size}，起播中位数 ${median}ms"
        }
        val text = lines.joinToString("\n")
        Log.i(TAG, "=== summary ===\n$text\n(csv: ${csv.absolutePath})")
        say("$text\n\n$csv")
    }

    private fun csvCell(s: String): String =
        if (s.any { it == ',' || it == '"' || it == '\n' }) "\"" + s.replace("\"", "\"\"") + "\"" else s

    private fun say(s: String) {
        status.text = s
    }

    private fun fetchChannels(base: String, user: String, pass: String): List<Channel> {
        val url = "$base/player_api.php?username=$user&password=$pass&action=get_live_streams"
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 15_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "WeWatchProbe/1.0")
        }
        val body = conn.inputStream.bufferedReader().use { it.readText() }
        val arr = JSONArray(body)
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            Channel(o.optInt("num", i + 1), o.optString("stream_id"), o.optString("name"))
        }
    }

    private companion object {
        const val TAG = "WeWatchProbe"
        const val DEFAULT_BASE = "https://ott.example.com/stream"
    }
}
