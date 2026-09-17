# ============================================================
# Aevion APK verifier
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File verify-apk.ps1
#
# Proves the built APK really contains what we think: the native plugin
# classes, the permissions and <queries> the voice feature depends on,
# and the current web assets. A build that silently drops the plugin is
# otherwise invisible until you try to talk to your phone.
# ============================================================
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$apk = Join-Path $root 'android\app\build\outputs\apk\debug\app-debug.apk'

# ---- locate aapt2 (portable SDK first, then ANDROID_HOME) ----
$sdk = if (Test-Path 'C:\Users\vigne\aevion-tools\android-sdk') { 'C:\Users\vigne\aevion-tools\android-sdk' } else { $env:ANDROID_HOME }
$aapt2 = $null
if ($sdk) {
  $aapt2 = Get-ChildItem -Path (Join-Path $sdk 'build-tools') -Filter 'aapt2.exe' -Recurse -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}

if (-not (Test-Path $apk)) {
  Write-Host "No APK at $apk" -ForegroundColor Red
  Write-Host "Build it first:  powershell -ExecutionPolicy Bypass -File build-apk.ps1"
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

Write-Host "Native plugin (compiled into classes.dex)"
$dexHits = 0
$sawCallback = $false
foreach ($dex in ($zip.Entries | Where-Object { $_.FullName -like "classes*.dex" })) {
  $ms = New-Object IO.MemoryStream
  $s = $dex.Open(); $s.CopyTo($ms); $s.Close()
  $text = [Text.Encoding]::ASCII.GetString($ms.ToArray())
  if ($text.Contains("SpeechPlugin")) { $dexHits++ }
  if ($text.Contains("micPermission")) { $sawCallback = $true }
  $ms.Dispose()
}
Check "SpeechPlugin class in dex" ($dexHits -gt 0) "not found"
Check "micPermission permission callback in dex" $sawCallback "not found"

Write-Host ""
Write-Host "Manifest"
if ($aapt2) {
  $badging = & $aapt2 dump badging $apk 2>$null
  Check "package is com.aevion.app" (($badging | Select-String "package: name='com.aevion.app'").Count -gt 0) "wrong package"
  Check "RECORD_AUDIO declared" (($badging | Select-String "RECORD_AUDIO").Count -gt 0) "missing"
  $tree = & $aapt2 dump xmltree --file AndroidManifest.xml $apk 2>$null
  Check "RecognitionService <queries> entry" (($tree | Select-String "android.speech.RecognitionService").Count -gt 0) "missing (Android 11+ hides speech services without it)"
} else {
  Write-Host "  SKIP  manifest checks - aapt2 not found (looked under $sdk)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Web assets"
$index = EntryText "assets/public/index.html"
Check "index.html versioned (>= v=050)" ($index -and $index.Contains("?v=0")) "asset versions missing"
$core = EntryText "assets/public/js/core.js"
Check "core.js present" ($core -and $core.Length -gt 1000) "missing"
Check "core.js unwraps event payloads" ($core -and $core.Contains("e && e.detail")) "event fix missing - voice input would send [object CustomEvent]"
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
