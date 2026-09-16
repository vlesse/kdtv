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
    namespace = "com.wewatch.tv"
    compileSdk = 35

    defaultConfig {
        /*
         * 包名不跟着产品改名走。
         *
         * 产品叫 KDTV 了，但包名是「这台盒子上的这个应用」的身份，和签名一起
         * 决定了升级能不能覆盖。改成 com.kdtv.tv 之后，对每一台已经装了的电视
         * 来说那是**另一个应用**：老的卸不掉、新的装上去是第二个图标，
         * 而且 ANDROID_ID 会变，全部设备要重新注册一遍。
         *
         * 客人看到的名字在 res/values/strings.xml 的 app_name 里，那个是 KDTV。
         */
        applicationId = "com.wewatch.tv"
        // Android 5.0 covers essentially every set-top box still in service.
        minSdk = 21
        targetSdk = 35
        versionCode = 4
        versionName = "1.2.1"

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
