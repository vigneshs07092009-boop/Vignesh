# ============================================================
# Aevion -> phone (adb install in place)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File install-to-phone.ps1
#        powershell ... -File install-to-phone.ps1 -Apk "C:\path\to\Aevion.apk"
#        powershell ... -File install-to-phone.ps1 -Wait 300        # wait for the phone
#        powershell ... -File install-to-phone.ps1 -Log             # tail the app's log after install
#
# `adb install -r` is *replace*: Android installs the new build over the old
# one and keeps every byte of app data. Never uninstall to "make room" — that
# is the one thing that does destroy the data.
#
# Paths are derived from this script's own location, so the same file works
# from the repo copy and from your build folder.
# ============================================================
param(
  [string] $Apk  = '',
  [int]    $Wait = 0,
  [switch] $Log
)

$ErrorActionPreference = 'Stop'

$PKG      = 'com.aevion.app'
$tools    = 'C:\Users\vigne\aevion-tools'
$sdk      = Join-Path $tools 'android-sdk'
$adb      = Join-Path $sdk 'platform-tools\adb.exe'
$repoDocs = 'C:\Users\vigne\OneDrive\Documents'

# ---- find adb: portable SDK, then ANDROID_HOME/SDK_ROOT ----
if (-not (Test-Path $adb)) {
  if ($env:ANDROID_HOME) { $adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe' }
  elseif ($env:SDK_ROOT) { $adb = Join-Path $env:SDK_ROOT 'platform-tools\adb.exe' }
}
if (-not (Test-Path $adb)) {
  Write-Host 'adb.exe not found. Install the Android platform-tools, or edit $sdk at the top of this script.' -ForegroundColor Red
  exit 1
}

# ---- find the APK: explicit, then the published release, then a local build ----
if (-not $Apk) {
  $candidates = @(
    (Join-Path $repoDocs 'Aevion.apk'),
    (Join-Path $PSScriptRoot 'android\app\build\outputs\apk\release\app-release.apk'),
    (Join-Path $PSScriptRoot 'android\app\build\outputs\apk\debug\app-debug.apk')
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { $Apk = $c; break }
  }
}
if (-not $Apk -or -not (Test-Path $Apk)) {
  Write-Host 'No APK found. Build one first, or pass -Apk "C:\path\to\Aevion.apk".' -ForegroundColor Red
  exit 1
}

$size = [math]::Round((Get-Item $Apk).Length / 1MB, 2)
$sha  = (Get-FileHash -Algorithm SHA256 $Apk).Hash.ToLower()

Write-Host ''
Write-Host ('APK   {0}' -f $Apk)
Write-Host ('      {0} MB   sha256 {1}' -f $size, $sha)
Write-Host ('adb   {0}' -f $adb)
Write-Host ''

# ---- wait for an authorized device ----
function Get-Device {
  $lines = & $adb devices | Select-Object -Skip 1
  foreach ($l in $lines) {
    $t = $l.Trim()
    if (-not $t) { continue }
    $parts = $t -split '\s+'
    if ($parts.Count -ge 2 -and $parts[1] -eq 'device') { return $parts[0] }
  }
  return $null
}

$serial = Get-Device
$deadline = (Get-Date).AddSeconds([math]::Max($Wait, 0))
while (-not $serial -and (Get-Date) -lt $deadline) {
  Write-Host 'Waiting for a phone... (USB debugging on, tap Allow on the phone)' -ForegroundColor Yellow
  Start-Sleep -Seconds 3
  $serial = Get-Device
}

if (-not $serial) {
  Write-Host ''
  Write-Host 'No phone is attached. Do this, then run this script again:' -ForegroundColor Red
  Write-Host '  1. Phone: Settings -> About phone -> tap "Build number" 7x'
  Write-Host '  2. Phone: Settings -> Developer options -> USB debugging = on'
  Write-Host '  3. Plug the phone in (a data cable, not charge-only)'
  Write-Host '  4. Tap Allow on the "Allow USB debugging?" prompt (tick Always allow)'
  Write-Host ''
  Write-Host 'Already plugged in but missing? Try:'
  Write-Host ('  "{0}" kill-server; "{0}" devices -l' -f $adb)
  Write-Host '  or revoke USB debugging authorisations on the phone and replug.'
  exit 2
}

# ---- read the version currently on the phone, before we touch it ----
function Get-InstalledVersion {
  $d = (& $adb -s $serial shell dumpsys package $PKG 2>$null) -join "`n"
  $vc = if ($d -match 'versionCode=(\d+)') { $Matches[1] } else { 'not installed' }
  $vn = if ($d -match 'versionName=([^\s]+)') { $Matches[1] } else { '' }
  $fi = if ($d -match 'firstInstallTime=(.+)') { $Matches[1].Trim() } else { '' }
  $lu = if ($d -match 'lastUpdateTime=(.+)') { $Matches[1].Trim() } else { '' }
  return [pscustomobject]@{ code = $vc; name = $vn; first = $fi; last = $lu }
}

$before = Get-InstalledVersion
Write-Host ('On the phone now: versionCode {0} {1}' -f $before.code, $before.name)

# ---- install in place ----
Write-Host ''
Write-Host 'Installing (replace, keeping data)...' -ForegroundColor Cyan
& $adb -s $serial install -r $Apk
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host 'Install refused. The usual reasons, in order of likelihood:' -ForegroundColor Red
  Write-Host '  INSTALL_FAILED_UPDATE_INCOMPATIBLE  the phone has a build signed with a DIFFERENT key.'
  Write-Host '                                      Uninstalling would fix it, and would also erase all app data.'
  Write-Host '  INSTALL_FAILED_VERSION_DOWNGRADE    the APK is older than what is installed (adb install -r -d to force).'
  Write-Host '  INSTALL_FAILED_INSUFFICIENT_STORAGE free some space on the phone.'
  Write-Host '  device unauthorized                tap Allow on the phone, or revoke authorisations and replug.'
  exit 1
}

# ---- prove it went in place ----
$after = Get-InstalledVersion
Write-Host ''
Write-Host ('Now on the phone: versionCode {0} {1}' -f $after.code, $after.name) -ForegroundColor Green
Write-Host ('  firstInstallTime  {0}' -f $after.first)
Write-Host ('  lastUpdateTime    {0}' -f $after.last)
if ($before.first -and $after.first -eq $before.first) {
  Write-Host '  firstInstallTime is unchanged -> the app was updated in place, nothing was uninstalled.' -ForegroundColor Green
} elseif ($before.code -eq 'not installed') {
  Write-Host '  This was a first install (there was nothing to keep).' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Next, on the phone: open Aevion -> Settings -> App updates -> Check.'
Write-Host 'It should report the running version, and either "up to date" or an offer to install a newer build.'
Write-Host ''

if ($Log) {
  Write-Host 'Tailing the app log (Ctrl+C to stop)...' -ForegroundColor Cyan
  & $adb -s $serial logcat -v time --pid=(& $adb -s $serial shell pidof $PKG)
}
