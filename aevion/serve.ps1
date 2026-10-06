# ============================================================
# Aevion PC Launcher — serve.ps1
# Serves the app on http://localhost:8787 and opens your browser.
# No installation, no admin rights, no internet needed.
# Run:  right-click -> "Run with PowerShell",  or:  powershell -File serve.ps1
# ============================================================
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$port = 8787

Write-Host ""
Write-Host "  AEVION - local server" -ForegroundColor Cyan
Write-Host "  $canon   (Ctrl+C to stop)" -ForegroundColor Green
Write-Host ""

$listener = New-Object System.Net.HttpListener
# The app has ONE canonical address: http://127.0.0.1:8787 - the address the
# installed app and the desktop launcher open. Opening http://localhost:8787
# instead would be a second origin to the browser (separate saved data,
# separate service worker), so a brain configured through one door looks
# missing when you come back through the other. Bind both names, open one.
$listener.Prefixes.Add("http://localhost:$port/")
try {
  $listener.Prefixes.Add("http://127.0.0.1:$port/")
  $canon = "http://127.0.0.1:$port/"
} catch {
  $canon = "http://localhost:$port/"   # no ACL for the raw IP: fall back
}
$listener.Start()
Start-Process $canon

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon'
  '.jpg' = 'image/jpeg'; '.webp' = 'image/webp'; '.woff2' = 'font/woff2'
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $path = $ctx.Request.Url.AbsolutePath
  if ($path -eq '/') { $path = '/index.html' }
  $file = Join-Path $root ($path -replace '/', '\')
  if ((Test-Path $file -PathType Leaf) -and ($file.StartsWith($root))) {
    $ext = [IO.Path]::GetExtension($file).ToLower()
    $ctx.Response.ContentType = if ($mime[$ext]) { $mime[$ext] } else { 'application/octet-stream' }
    $ctx.Response.Headers['Cache-Control'] = 'no-store'
    $bytes = [IO.File]::ReadAllBytes($file)
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  }
  else {
    $ctx.Response.StatusCode = 404
    $ctx.Response.Close()
    continue
  }
  $ctx.Response.Close()
}
