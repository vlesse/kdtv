import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/**
 * Release signing.
 *
 * The key lives OUTSIDE this directory (<keystore 目录>) on
 * purpose: everything under the project root gets tarred up and shipped to
 * the server on every deploy, and a signing key has no business being
 * there. Point `keystorePropsFile` elsewhere with -PkeystoreProps=... .
 *
 * Signature identity is forever. Every box that has the app installed can
 * only be upgraded by another APK signed with THIS key - a differently
 * signed build has to be uninstalled first, by hand, on every television.
 * That is why a trial must not go out signed with the debug key.
 */
val keystoreProps = Properties().apply {
    val path = (project.findProperty("keystoreProps") as String?)
        ?: "<keystore 目录>/keystore.properties"
    val f = file(path)
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.kdtv.tv"
    compileSdk = 35

    defaultConfig {
        /*
         * 包名从今天起冻结。
         *
         * 2026-09-16 趁还没有一家酒店上线，从 com.wewatch.tv 改成了 com.kdtv.tv。
         * **这是最后一次能改。** 包名是「这台盒子上的这个应用」的身份：
         * 改了之后，对每一台已经装机的电视来说这是**另一个应用** ——
         * 装不上去、只能先手动卸载旧的。一旦有酒店上线，那就是
         * 一个房间一个房间地跑。
         *
         * 实测澄清一件事：**ANDROID_ID 不会因为改包名而变**，它跟着签名钥匙走。
         * 这次改完，盒子报上来的还是原来那个设备号，服务端认得它，不用重新配对。
         * 真正会断的是 JS 桥的名字（见 web/src/api.ts）—— 那个和网页是一对，
         * 而网页和 APK 不会同时更新。
         */
        applicationId = "com.kdtv.tv"
        // Android 5.0 covers essentially every set-top box still in service.
        minSdk = 21
        targetSdk = 35
        versionCode = 5
        versionName = "1.3.0"

        // The ONLY address burned into the app. Everything else - the line,
        // the room, the stream URLs - is fetched from here at boot, which is
        // why nobody ever types a server address into a TV.
        buildConfigField("String", "PORTAL_URL", "\"${project.findProperty("portalUrl") ?: "http://10.0.2.2:9081/"}\"")
    }

    buildFeatures { buildConfig = true }

    signingConfigs {
        if (keystoreProps.getProperty("storeFile") != null) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Falls back to unsigned rather than silently signing with the
            // debug key: an unsigned APK refuses to install, which is a much
            // louder failure than a fleet that can never be upgraded.
            signingConfig = signingConfigs.findByName("release")
        }
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
}
