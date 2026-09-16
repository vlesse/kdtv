pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        // ijkplayer 只能从这里拿，见 probe/build.gradle.kts 里的说明。
        maven { setUrl("https://jitpack.io") }
    }
}
rootProject.name = "WeWatchTV"
include(":app")
include(":probe")
