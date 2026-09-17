# ============================================================
# Aevion APK build
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File build-apk.ps1
# Output: android\app\build\outputs\apk\debug\app-debug.apk
#
# Paths are derived from this script's own location, so the same file
# works from the repo copy and from your build folder.
# ============================================================
$ErrorActionPreference = 'Stop'

# ---- toolchain: edit these if you move the portable install ----
$tools = 'C:\Users\vigne\aevion-tools'
$jdk   = Join-Path $tools 'jdk-21.0.12.1+1'
$sdk   = Join-Path $tools 'android-sdk'

if (Test-Path $jdk) {
  $env:JAVA_HOME = $jdk
} elseif (-not $env:JAVA_HOME) {
  Write-Host "No JDK found. Install one, or edit `$jdk at the top of this script." -ForegroundColor Red
  exit 1
}

if (Test-Path $sdk) {
  $env:ANDROID_HOME = $sdk
} elseif (-not $env:ANDROID_HOME) {
  Write-Host "No Android SDK found. Install one, or edit `$sdk at the top of this script." -ForegroundColor Red
  exit 1
}

$root = $PSScriptRoot
Set-Location (Join-Path $root 'android')

Write-Host "Building Aevion debug APK..." -ForegroundColor Cyan
Write-Host ("  JAVA_HOME    = " + $env:JAVA_HOME)
Write-Host ("  ANDROID_HOME = " + $env:ANDROID_HOME)

& .\gradlew.bat assembleDebug --console=plain

if ($LASTEXITCODE -eq 0) {
  $apk = "app\build\outputs\apk\debug\app-debug.apk"
  Write-Host ""
  Write-Host "SUCCESS! APK at:" -ForegroundColor Green
  Write-Host (Join-Path (Join-Path $root 'android') $apk)
  Write-Host ("Size: " + [math]::Round((Get-Item $apk).Length/1MB,1) + " MB")
} else {
  Write-Host "BUILD FAILED - see output above" -ForegroundColor Red
  exit 1
}
