# WeWatch TV - Android shell

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

The APK must be signed before it will install on a real box; add a
`signingConfigs` block to `app/build.gradle.kts` with your keystore.

## When the shell itself must be updated

Rarely - only for native changes such as a new Android target or a player
switch. `GET /api/app/version` returns `minShellVersion` for exactly this: bump
it, and the web app can tell the viewer their box needs a new APK.
