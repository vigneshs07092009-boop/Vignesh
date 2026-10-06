# ============================================================
# Aevion PWA icon generator
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-icons.ps1
#
# Turns aevion/assets/icon.svg into the raster PNG icons a browser needs:
#
#     aevion/assets/icon-512.png   512x512   install prompt, splash
#     aevion/assets/icon-192.png   192x192   the size Chromium asks for
#
# Why raster icons exist at all: the manifest used to ship *only* the SVG.
# Chromium will not offer "Install this site as an app" without a raster icon
# of at least 144x144, and an installed shortcut needs a real bitmap for the
# Start menu and the taskbar. The SVG also carries an <animate> element —
# fine in a tab, wrong for a launcher icon.
#
# Two things make this not a one-liner:
#   1. Rasterising is done by headless Edge/Chrome (the same engine that will
#      install the app), because nothing here depends on an SVG library.
#   2. A headless screenshot always composites onto white, so the icon's
#      rounded corners come out as white wedges. They are rebuilt here as
#      alpha, analytically: the artwork is a 512x512 rect with rx=110, so the
#      covered span of every row in each corner is known exactly, and the
#      half-covered pixel at the boundary gets a real coverage value instead
#      of a jagged step.
# ============================================================
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$svg  = Join-Path $root 'aevion\assets\icon.svg'
if (-not (Test-Path $svg)) { Write-Host "No $svg" -ForegroundColor Red; exit 1 }

# ---- the artwork's own geometry (must match icon.svg) ----
$VIEWBOX    = 512.0
$CORNER_RX  = 110.0

# ---- find a Chromium we can drive headlessly ----
$browser = $null
foreach ($p in @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
)) { if (Test-Path $p) { $browser = $p; break } }
if (-not $browser) { Write-Host 'No Edge or Chrome found to render the SVG.' -ForegroundColor Red; exit 1 }

# ---- render the SVG big ----
$BIG = 1024
$tmp = Join-Path $env:TEMP 'aevion-icon-render.png'
if (Test-Path $tmp) { Remove-Item $tmp -Force }
$uri = 'file:///' + ($svg -replace '\\', '/')

# Chromium has no --user-data-dir by default: a second run can hand off to a
# still-running instance and never exit. A private profile removes that failure
# mode entirely (and keeps the user's own Edge session untouched).
$profile = Join-Path $env:TEMP ('aevion-icon-profile-' + $PID)

# Chromium chatters on stderr, which PowerShell turns into a terminating error
# under $ErrorActionPreference = 'Stop' — relax it for this one call.
$pref = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
# Capture to a variable rather than piping to Out-Null or >/dev/null: with its
# output discarded outright this headless Edge never exits, and the call hangs
# until it is killed. Reading the output to EOF (as here, or as `| tail` in a
# shell) is what lets it finish.
$chromiumLog = & $browser --headless=new --disable-gpu --hide-scrollbars --no-first-run `
  --no-default-browser-check --force-device-scale-factor=1 `
  "--user-data-dir=$($profile -replace '\\', '/')" `
  "--window-size=$BIG,$BIG" `
  "--screenshot=$($tmp -replace '\\', '/')" `
  $uri 2>&1
$ErrorActionPreference = $pref

# The screenshot can be flushed a moment after the process returns.
for ($w = 0; $w -lt 30 -and -not (Test-Path $tmp); $w++) { Start-Sleep -Milliseconds 500 }

if (-not (Test-Path $tmp)) {
  Write-Host 'Headless render produced nothing.' -ForegroundColor Red
  if (Test-Path $profile) { Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue }
  exit 1
}

# ---- resize, then rebuild the rounded corners as alpha ----
function Convert-ToIcon {
  param([System.Drawing.Image] $Source, [int] $Size, [string] $Out)

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CompositingMode    = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($Source, (New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)))
  $g.Dispose()

  # corner radius scaled from the artwork
  $r = $CORNER_RX * $Size / $VIEWBOX

  # only the four r x r corner blocks can be anything but fully opaque
  $blocks = @(
    @{ x0 = 0;            y0 = 0;            mx = 1;  my = 1  },   # top-left
    @{ x0 = $Size - $r;   y0 = 0;            mx = -1; my = 1  },   # top-right
    @{ x0 = 0;            y0 = $Size - $r;   mx = 1;  my = -1 },   # bottom-left
    @{ x0 = $Size - $r;   y0 = $Size - $r;   mx = -1; my = -1 }    # bottom-right
  )

  foreach ($b in $blocks) {
    $rows = [int][Math]::Ceiling($r)
    for ($i = 0; $i -lt $rows; $i++) {
      # distance from the corner's centre, measured along the row
      $dy = $r - ($i + 0.5)
      if ($dy -le 0) { continue }
      $inner = $r * $r - $dy * $dy
      if ($inner -le 0) {
        # the whole row is outside the curve
        for ($j = 0; $j -lt $rows; $j++) {
          $bmp.SetPixel([int]($b.x0 + $b.mx * $j), [int]($b.y0 + $b.my * $i), [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
        }
        continue
      }
      # x at which coverage starts: x >= r - sqrt(r^2 - dy^2) from the centre
      $edgeX = $r - [Math]::Sqrt($inner)
      $firstCols = [int][Math]::Floor($edgeX)
      for ($j = 0; $j -lt $firstCols; $j++) {
        $bmp.SetPixel([int]($b.x0 + $b.mx * $j), [int]($b.y0 + $b.my * $i), [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
      }
      # the one boundary pixel gets partial coverage -> a smooth edge
      if ($firstCols -lt $rows) {
        $cover = $edgeX - $firstCols
        if ($cover -lt 0) { $cover = 0 }
        if ($cover -gt 1) { $cover = 1 }
        $px = [int]($b.x0 + $b.mx * $firstCols)
        $py = [int]($b.y0 + $b.my * $i)
        $old = $bmp.GetPixel($px, $py)
        $bmp.SetPixel($px, $py, [System.Drawing.Color]::FromArgb([int][Math]::Round($cover * 255), $old.R, $old.G, $old.B))
      }
    }
  }

  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$src = [System.Drawing.Image]::FromFile($tmp)
$made = @()
foreach ($size in 512, 192) {
  $out = Join-Path $root ("aevion\assets\icon-{0}.png" -f $size)
  Convert-ToIcon -Source $src -Size $size -Out $out
  $made += [pscustomobject]@{ File = $out; Size = $size }
}
$src.Dispose()
Remove-Item $tmp -Force
if (Test-Path $profile) { Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue }

# ---- prove it is artwork, with transparent corners and no white wedges ----
Write-Host ''
$bad = 0
foreach ($m in $made) {
  $i = [System.Drawing.Image]::FromFile($m.File)
  $w = $i.Width
  $corner = $i.GetPixel(1, 1)                                  # outside the rounded rect
  $bg     = $i.GetPixel([int]($w / 2), 3)                      # inside the rect, near the top
  $mid    = $i.GetPixel([int]($w / 2), [int]($w / 2))          # the pulsing centre
  $ok = ($corner.A -eq 0) -and ($bg.R -lt 40) -and ($mid.G -gt 100)
  if (-not $ok) { $bad++ }
  Write-Host ("  {0}{1}  {2}x{2}  corner a={3}  top={4},{5},{6}  centre={7},{8},{9}" -f `
    $(if ($ok) { 'OK  ' } else { 'BAD ' }), (Split-Path $m.File -Leaf), $w, `
    $corner.A, $bg.R, $bg.G, $bg.B, $mid.R, $mid.G, $mid.B) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
  $i.Dispose()
}
Write-Host ''
if ($bad -gt 0) { Write-Host "$bad icon(s) look wrong." -ForegroundColor Red; exit 1 }
