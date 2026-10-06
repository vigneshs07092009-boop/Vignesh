# ============================================================
# Aevion desktop app installer (Windows)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-desktop-app.ps1
#        powershell ... -File tools\install-desktop-app.ps1 -Uninstall
#
# Puts Aevion in the Start menu and on the desktop as a real app: its own
# window, no browser chrome, its own icon - the same result as Edge's
# "Install this site as an app", without needing you to click through a
# browser prompt.
#
# What it creates:
#
#   %LOCALAPPDATA%\Aevion\launch.ps1   starts the local server if it is not
#                                      already up, then opens the app window
#   %LOCALAPPDATA%\Aevion\launch.vbs   runs launch.ps1 with no console window
#   %LOCALAPPDATA%\Aevion\aevion.ico   multi-resolution icon for the shortcuts
#   Start Menu\Programs\Aevion.lnk     the installed app
#   Desktop\Aevion.lnk                 the same thing, one click away
#
# The launcher is copied into %LOCALAPPDATA% rather than run from the repo, so
# the shortcuts keep working if the project moves - but the absolute paths are
# baked in, so re-run this script after moving the project.
#
# This file is deliberately pure ASCII. PowerShell 5.1 reads a .ps1 with no BOM
# using the system code page, so a stray typographic dash inside a string can
# shift the parser onto the wrong byte and produce baffling syntax errors.
# ============================================================
param([switch] $Uninstall)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root   = Split-Path $PSScriptRoot -Parent
$server = Join-Path $root 'tools\dev-server.mjs'
$png    = Join-Path $root 'aevion\assets\icon-512.png'
$tplPs1 = Join-Path $PSScriptRoot 'aevion-launch-template.ps1'
$tplVbs = Join-Path $PSScriptRoot 'aevion-launch-template.vbs'
$port   = 8787
$url    = "http://127.0.0.1:$port/"
$appDir = Join-Path $env:LOCALAPPDATA 'Aevion'
$startD = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$deskD  = Join-Path ([Environment]::GetFolderPath('Desktop'))
$lnks   = @((Join-Path $startD 'Aevion.lnk'), (Join-Path $deskD 'Aevion.lnk'))

# ---- uninstall ----
if ($Uninstall) {
  foreach ($l in $lnks) {
    if (Test-Path $l) { Remove-Item $l -Force; Write-Host "removed $l" }
  }
  if (Test-Path $appDir) { Remove-Item $appDir -Recurse -Force; Write-Host "removed $appDir" }
  Write-Host 'Aevion desktop app uninstalled. The web app itself is untouched.' -ForegroundColor Green
  exit 0
}

foreach ($need in @($png, $tplPs1, $tplVbs, $server)) {
  if (-not (Test-Path $need)) {
    Write-Host "Missing: $need" -ForegroundColor Red
    if ($need -eq $png) { Write-Host 'Run tools\make-icons.ps1 first.' }
    exit 1
  }
}

# ---- find Node ----
$node = $null
foreach ($p in @(
  (Join-Path $env:USERPROFILE 'aevion-tools\node-v22.14.0-win-x64\node.exe'),
  'C:\Program Files\nodejs\node.exe',
  'C:\Program Files (x86)\nodejs\node.exe'
)) { if (Test-Path $p) { $node = $p; break } }
if (-not $node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
}
if (-not $node) { Write-Host 'No node.exe found.' -ForegroundColor Red; exit 1 }

# ---- find a Chromium to host the app window ----
$edge = $null
foreach ($p in @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
)) { if (Test-Path $p) { $edge = $p; break } }
if (-not $edge) { Write-Host 'No Edge or Chrome found.' -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Force -Path $appDir | Out-Null

# ---- multi-resolution .ico from the 512 PNG ----
# Windows picks a different size for the Start menu, the taskbar, alt-tab and
# Explorer, so a single-size icon looks blurry in most of them. PNG-compressed
# entries are supported on Vista and later.
function Write-Ico {
  param([System.Drawing.Image] $Source, [int[]] $Sizes, [string] $Out)

  $blobs = New-Object System.Collections.ArrayList
  foreach ($s in $Sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CompositingMode    = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($Source, (New-Object System.Drawing.Rectangle(0, 0, $s, $s)))
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    [void]$blobs.Add($ms.ToArray())
    $ms.Dispose()
    $bmp.Dispose()
  }

  $fs = [System.IO.File]::Create($Out)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([UInt16]0)                 # reserved
  $bw.Write([UInt16]1)                 # 1 = icon
  $bw.Write([UInt16]$Sizes.Count)
  $offset = 6 + 16 * $Sizes.Count
  for ($i = 0; $i -lt $Sizes.Count; $i++) {
    $s = $Sizes[$i]
    if ($s -ge 256) { $dim = [Byte]0 } else { $dim = [Byte]$s }   # 0 means 256
    $bw.Write($dim)
    $bw.Write($dim)
    $bw.Write([Byte]0)                 # palette colours
    $bw.Write([Byte]0)                 # reserved
    $bw.Write([UInt16]1)               # colour planes
    $bw.Write([UInt16]32)              # bits per pixel
    $bw.Write([UInt32]$blobs[$i].Length)
    $bw.Write([UInt32]$offset)
    $offset += $blobs[$i].Length
  }
  foreach ($b in $blobs) { $bw.Write($b) }
  $bw.Flush()
  $bw.Close()
  $fs.Close()
}

$ico = Join-Path $appDir 'aevion.ico'
$src = [System.Drawing.Image]::FromFile($png)
Write-Ico -Source $src -Sizes @(16, 24, 32, 48, 64, 128, 256) -Out $ico
$src.Dispose()

# ---- generate the launcher from its templates ----
$launchPs1 = Join-Path $appDir 'launch.ps1'
$launchVbs = Join-Path $appDir 'launch.vbs'

$tpl = Get-Content -Raw $tplPs1
$tpl = $tpl.Replace('__PORT__',   "$port")
$tpl = $tpl.Replace('__URL__',    $url)
$tpl = $tpl.Replace('__NODE__',   $node)
$tpl = $tpl.Replace('__SERVER__', $server)
$tpl = $tpl.Replace('__EDGE__',   $edge)
Set-Content -Path $launchPs1 -Value $tpl -Encoding UTF8

$vbs = (Get-Content -Raw $tplVbs).Replace('__LAUNCH__', $launchPs1)
Set-Content -Path $launchVbs -Value $vbs -Encoding ASCII

# ---- the shortcuts ----
$wsh = New-Object -ComObject WScript.Shell
foreach ($l in $lnks) {
  $dir = Split-Path $l -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $lnk = $wsh.CreateShortcut($l)
  $lnk.TargetPath       = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $lnk.Arguments        = '"' + $launchVbs + '"'
  $lnk.WorkingDirectory = $appDir
  $lnk.IconLocation     = "$ico,0"
  $lnk.Description      = 'Aevion - Private AI Assistant'
  $lnk.Save()
}
[void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($wsh)

# ---- report ----
Write-Host ''
Write-Host 'Aevion is installed as a desktop app.' -ForegroundColor Green
Write-Host "  launcher   $launchPs1"
Write-Host "  icon       $ico"
foreach ($l in $lnks) {
  if (Test-Path $l) {
    Write-Host "  shortcut   $l" -ForegroundColor Gray
  } else {
    Write-Host "  MISSING    $l" -ForegroundColor Red
  }
}
Write-Host "  node       $node"
Write-Host "  browser    $edge"
Write-Host "  url        $url"
Write-Host ''
Write-Host 'Launch it from the Start menu or the desktop shortcut. The launcher starts'
Write-Host 'its own server, so it works after a reboot with nothing else running.'
Write-Host 'Remove it with:  -Uninstall'
