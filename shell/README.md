# KDTV - Android shell

A deliberately thin WebView wrapper. It contributes three things and nothing else:

1. opens the portal URL burned in at build time,
2. injects `window.__DEVICE_ID__` and (when the platform still exposes it)
   `window.__DEVICE_MAC__`, so the BFF can identify and auto-provision the box,
3. forwards the remote's Back button into the page as `Escape`.

Everything a viewer sees comes from the web bundle the portal serves, so a UI
change is a server deploy - the APK does not need to be reinstalled on boxes
already in the field.

## Build

    ./gradlew assembleRelease -PportalUrl=https://tv.your-domain.com/

`portalUrl` defaults to `http://10.0.2.2:9081/`, which is how the Android
emulator reaches a service on the host machine.

The release build signs itself from `<keystore 目录>/keystore.properties`
(point elsewhere with `-PkeystoreProps=...`). If that file is missing the build
falls back to *unsigned* rather than quietly using the debug key - an unsigned
APK refuses to install, which is a far louder failure than a fleet that can
never be upgraded.

## Brand assets

The TV home row shows one thing for this app: `drawable/ic_banner.xml`, 320x180.
Not the icon - the icon only ever appears under Settings - Apps.

Both the banner and the icon are **generated**, not hand-drawn:

    python scripts/brand.py

Vector drawables cannot draw text, so the script converts Noto Sans Bold - the
same family the TV interface uses - into outlines with fontTools and writes the
path data into the XML. Edit the script, not the XML.

Two things about the banner that are deliberate and easy to undo by accident:

- **Light field.** The launcher background is near-black. The banner this
  replaced was dark, and it simply disappeared into the row.
- **A word, not a symbol.** The tile is about a tenth of the screen wide and
  gets looked at from three metres. A symbol at that size is a smudge.

The launcher caches banners aggressively. After changing one, a reinstall is
not enough - `adb shell pm clear com.google.android.apps.tv.launcherx` (or a
reboot) is what makes the new image show up.

## When the shell itself must be updated

Rarely - only for native changes such as a new Android target or a player
switch. `GET /api/app/version` returns `minShellVersion` for exactly this: bump
it, and the web app can tell the viewer their box needs a new APK.
