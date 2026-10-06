# Aevion launcher (generated from tools/aevion-launch-template.ps1).
#
# Starts the local static server if it is not already listening, then opens the
# web app in its own window (browser app mode: no tabs, no address bar), which
# is what makes it behave like an installed app rather than a bookmarked page.
#
# The installer replaces the __TOKEN__ placeholders with absolute paths, so this
# file is a template and is never run from the repo.
$ErrorActionPreference = 'SilentlyContinue'

$Port   = __PORT__
$Url    = '__URL__'
$Node   = '__NODE__'
$Server = '__SERVER__'
$Edge   = '__EDGE__'

function Test-AevionPort([int] $p) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $p); $c.Close(); return $true }
  catch { return $false }
}

# Only start a server if nothing already answers on the port, so launching the
# app twice (or alongside a dev server) does not fail on a busy port.
if (-not (Test-AevionPort $Port)) {
  Start-Process -FilePath $Node -ArgumentList @($Server, "$Port") -WindowStyle Hidden
  for ($i = 0; $i -lt 60 -and -not (Test-AevionPort $Port); $i++) { Start-Sleep -Milliseconds 250 }
}

Start-Process -FilePath $Edge -ArgumentList "--app=$Url"
