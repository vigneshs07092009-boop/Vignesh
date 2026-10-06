# ============================================================
# Aevion APK verifier
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File verify-apk.ps1
#        powershell -NoProfile -ExecutionPolicy Bypass -File verify-apk.ps1 -ApkPath <any.apk>
#
# Proves the built APK really contains what we think: the native plugin
# classes, the permissions and <queries> the app depends on, and the web
# assets at the version the APK claims. A build that silently drops a
# plugin, or packages a stale www/, is otherwise invisible until the
# feature fails on the phone.
#
# Defaults to the debug APK; pass -ApkPath to check a release build instead.
# ============================================================
param(
  [string]$ApkPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
if ($ApkPath) {
  $apk = (Resolve-Path $ApkPath).Path
} else {
  $apk = Join-Path $root 'android\app\build\outputs\apk\debug\app-debug.apk'
}

# ---- locate aapt2 (portable SDK first, then ANDROID_HOME) ----
$sdk = if (Test-Path 'C:\Users\vigne\aevion-tools\android-sdk') { 'C:\Users\vigne\aevion-tools\android-sdk' } else { $env:ANDROID_HOME }
$aapt2 = $null
if ($sdk) {
  $aapt2 = Get-ChildItem -Path (Join-Path $sdk 'build-tools') -Filter 'aapt2.exe' -Recurse -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}

if (-not (Test-Path $apk)) {
  Write-Host "No APK at $apk" -ForegroundColor Red
  Write-Host "Build it first:  powershell -ExecutionPolicy Bypass -File build-release.ps1"
  exit 1
}

$fail = 0
function Check($label, $ok, $detail) {
  if ($ok) { Write-Host ("  PASS  " + $label) -ForegroundColor Green }
  else { Write-Host ("  FAIL  " + $label + "  " + $detail) -ForegroundColor Red; $script:fail++ }
}

Write-Host ""
Write-Host ("APK: {0}" -f $apk)
Write-Host ("     {0} MB, built {1}" -f [math]::Round((Get-Item $apk).Length/1MB,2), (Get-Item $apk).LastWriteTime)
Write-Host ""

$zip = [IO.Compression.ZipFile]::OpenRead($apk)
function EntryText($name) {
  $e = $zip.Entries | Where-Object { $_.FullName -eq $name }
  if (-not $e) { return $null }
  $sr = New-Object IO.StreamReader($e.Open())
  $t = $sr.ReadToEnd(); $sr.Close(); return $t
}

Write-Host "Native plugins (compiled into classes.dex)"
$sawSpeech = $false
$sawApps = $false
$sawCallback = $false
$sawUpdate = $false
$sawUpdateRecv = $false
foreach ($dex in ($zip.Entries | Where-Object { $_.FullName -like "classes*.dex" })) {
  $ms = New-Object IO.MemoryStream
  $s = $dex.Open(); $s.CopyTo($ms); $s.Close()
  $text = [Text.Encoding]::ASCII.GetString($ms.ToArray())
  if ($text.Contains("SpeechPlugin")) { $sawSpeech = $true }
  if ($text.Contains("AppsPlugin")) { $sawApps = $true }
  if ($text.Contains("micPermission")) { $sawCallback = $true }
  if ($text.Contains("UpdatePlugin")) { $sawUpdate = $true }
  if ($text.Contains("UpdateStatusReceiver")) { $sawUpdateRecv = $true }
  $ms.Dispose()
}
Check "SpeechPlugin class in dex" $sawSpeech "not found"
Check "micPermission permission callback in dex" $sawCallback "not found"
Check "AppsPlugin class in dex" $sawApps "not found - the phone cannot list or open installed apps"
Check "UpdatePlugin class in dex" $sawUpdate "not found - in-place self-update cannot work"
Check "UpdateStatusReceiver class in dex" $sawUpdateRecv "not found - the system install dialog would never appear"

Write-Host ""
Write-Host "Manifest"
$badging = $null
if ($aapt2) {
  $badging = & $aapt2 dump badging $apk 2>$null
  Check "package is com.aevion.app" (($badging | Select-String "package: name='com.aevion.app'").Count -gt 0) "wrong package"
  Check "RECORD_AUDIO declared" (($badging | Select-String "RECORD_AUDIO").Count -gt 0) "missing"
  $tree = & $aapt2 dump xmltree --file AndroidManifest.xml $apk 2>$null
  Check "RecognitionService <queries> entry" (($tree | Select-String "android.speech.RecognitionService").Count -gt 0) "missing (Android 11+ hides speech services without it)"
  Check "launcher-app <queries> entry" (($tree | Select-String "android.intent.category.LAUNCHER").Count -gt 0) "missing (Android 11+ returns an empty installed-app list without it)"
  Check "REQUEST_INSTALL_PACKAGES declared" (($badging | Select-String "REQUEST_INSTALL_PACKAGES").Count -gt 0) "missing - the system would refuse the in-place update session"
} else {
  Write-Host "  SKIP  manifest checks - aapt2 not found (looked under $sdk)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Web assets"
$core = EntryText "assets/public/js/core.js"
Check "core.js present" ($core -and $core.Length -gt 1000) "missing"
Check "core.js unwraps event payloads" ($core -and $core.Contains("e && e.detail")) "event fix missing - voice input would send [object CustomEvent]"

# The version the APK claims must be the version of the code inside it.
$webVersion = ''
if ($core) {
  $vm = [regex]::Match($core, "version:\s*'([0-9]+\.[0-9]+\.[0-9]+)'")
  if ($vm.Success) { $webVersion = $vm.Groups[1].Value }
}
Check "web app version readable" ($webVersion -ne '') "no version: 'x.y.z' in the bundled core.js"

if ($badging -and $webVersion) {
  $pkgLine = ($badging | Select-String '^package:').ToString()
  $apkVersion = [regex]::Match($pkgLine, "versionName='([^']+)'").Groups[1].Value
  Check ("APK versionName matches the bundled web app (" + $webVersion + ")") ($apkVersion -eq $webVersion) ("APK says '" + $apkVersion + "' but the bundled core.js says '" + $webVersion + "' - stale sync")
}

$index = EntryText "assets/public/index.html"
Check "index.html versioned" ($index -and $index.Contains("?v=")) "asset version tags missing"
if ($webVersion -and $index) {
  $vShort = $webVersion -replace '\.', ''
  Check ("cache-busting tags are ?v=" + $vShort) ($index.Contains("?v=" + $vShort)) "index.html tags do not match the bundled version - a phone would keep running cached JS"
}

# The manifest must ship a RASTER icon or no browser will offer to install the
# app: Chromium needs at least a 144px bitmap, and an SVG-only manifest (which
# is what shipped before 0.6.7) is simply not installable. The SVG animates,
# too, which is wrong for a launcher icon. Checked here so it cannot regress.
foreach ($icon in @('assets/public/assets/icon-192.png', 'assets/public/assets/icon-512.png')) {
  $entry = $zip.Entries | Where-Object { $_.FullName -eq $icon }
  Check ((Split-Path $icon -Leaf) + " bundled") ($entry -and $entry.Length -gt 1000) "missing - a browser cannot install the app without a raster icon"
}
$manifest = EntryText "assets/public/manifest.json"
Check "manifest lists the raster icons" ($manifest -and $manifest.Contains("icon-192.png") -and $manifest.Contains("icon-512.png")) "manifest is SVG-only - no install prompt anywhere"

$providers = EntryText "assets/public/js/providers.js"
Check "providers.js bundled" ($providers -and $providers.Contains("Aevion.providers")) "missing - no AI provider layer in the APK"
$tools = EntryText "assets/public/js/tools.js"
Check "tools.js bundled" ($tools -and $tools.Contains("Aevion.tools")) "missing - no permission-tiered tool layer in the APK"
$memory = EntryText "assets/public/js/memory.js"
Check "memory.js bundled" ($memory -and $memory.Contains("Aevion.memory")) "missing - no layered memory in the APK"
$evolve = EntryText "assets/public/js/evolve.js"
Check "evolve.js bundled" ($evolve -and $evolve.Contains("Aevion.evolve")) "missing - no self-upgrade / consent layer in the APK"
$apps = EntryText "assets/public/js/apps.js"
Check "apps.js bundled" ($apps -and $apps.Contains("Aevion.apps")) "missing - apps & websites plugin layer gone"
$update = EntryText "assets/public/js/update.js"
Check "update.js bundled" ($update -and $update.Contains("Aevion.update")) "missing - no self-update layer in the APK"
Check "update.js refuses installs without consent" ($update -and $update.Contains("consent !== true")) "consent gate missing - update must never install silently"
Check "update.js verifies the download checksum" ($update -and $update.Contains("fileSha256")) "checksum gate missing"

$voice = EntryText "assets/public/js/voice.js"
Check "voice.js has native bridge" ($voice -and $voice.Contains("Plugins") -and $voice.Contains("Speech")) "native path missing"
Check "voice.js guards speechSynthesis" ($voice -and $voice.Contains("typeof speechSynthesis")) "unguarded (throws in WebView)"
$md = EntryText "assets/public/js/markdown.js"
Check "markdown.js bundled" ($md -and $md.Contains("renderInto")) "missing"
$engine = $zip.Entries | Where-Object { $_.FullName -eq "assets/public/vendor/webllm.esm.js" }
Check "WebLLM engine bundled" ($null -ne $engine) "missing"

$zip.Dispose()
Write-Host ""
if ($fail -eq 0) { Write-Host "ALL CHECKS PASSED" -ForegroundColor Green } else { Write-Host ("{0} CHECK(S) FAILED" -f $fail) -ForegroundColor Red }
Write-Host ""
exit $fail
