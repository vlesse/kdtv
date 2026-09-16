plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/*
 * 播放引擎实测工装。不发给客人，也不参与出包 —— 它只回答一个问题：
 * 同一台机器、同一个网络、同一分钟里，换一个播放内核，91 个台能通多少、起播多久。
 *
 * 单独一个模块而不是塞进 app 里，是因为它要带进来一整套 Media3 依赖。
 * 量完之后如果决定不换内核，这些依赖不该留在发给酒店的包里。
 */
android {
    namespace = "com.wewatch.probe"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.wewatch.probe"
        minSdk = 21
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        // debug 签名足够 —— 这个包永远不会装到客人的电视上。
        release { isMinifyEnabled = false }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.media3:media3-exoplayer:1.5.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.5.1")

    /*
     * IJKPlayer（FFmpeg 内核）。
     *
     * 官方的 tv.danmaku.ijk.media 只发在 jcenter 上，而 jcenter 已经关了 ——
     * 今天想用 ijkplayer，要么自己带 NDK 编，要么用别人发在 jitpack 上的构建。
     * 这里用 GSYVideoPlayer 的，它就是同一个 ijkplayer，带 FFmpeg 和 https。
     */
    implementation("com.github.CarGuo.GSYVideoPlayer:gsyVideoPlayer-java:v8.6.0-release-jitpack")
    implementation("com.github.CarGuo.GSYVideoPlayer:gsyVideoPlayer-x86:v8.6.0-release-jitpack")
    implementation("com.github.CarGuo.GSYVideoPlayer:gsyVideoPlayer-armv7a:v8.6.0-release-jitpack")
    implementation("com.github.CarGuo.GSYVideoPlayer:gsyVideoPlayer-arm64:v8.6.0-release-jitpack")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
