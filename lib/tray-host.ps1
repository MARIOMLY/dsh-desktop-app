# tray-host.ps1 -- Windows notification-area host for the DeepSeek Harness desktop app.
#
# Why this exists: the "desktop app" is Microsoft Edge running in --app mode, i.e. a
# browser window. A browser page CANNOT minimise itself to the system tray, and a
# closed window takes its process with it, so tray residency needs a separate
# long-lived process -- this script, with the C# type in tray-host.cs.
#
# Behaviour:
#   * notification-area icon that survives the app window being closed
#   * menu: open/restore the window, minimise to tray, restart the service, quit
#   * the local DSH server keeps running while this host is alive
#   * single instance (a second start notices the first and exits)
#   * while running it rewrites tray-url.txt with the tokenised boot URL, so the
#     window can be reopened later without reading the server log
#
# ASCII-ONLY on purpose: PowerShell 5.1 reads a BOM-less .ps1 with the ANSI code
# page, so a non-ASCII byte here is a latent parse failure (hit three times already).
# The C# lives in a sibling file loaded through $PSScriptRoot for the same reason:
# no CJK characters ever reach this script's literals.
#
# Parameters are all optional on purpose: the generated launcher then passes NOTHING
# on the command line, which sidesteps the whole class of "path with spaces got
# re-split" failures (observed twice: "Program Files (x86)" and a CJK script path).

[CmdletBinding()]
param(
  [string]$StateDir,
  [string]$Browser,
  [string]$Title,
  [string]$IconFile
)

$ErrorActionPreference = 'Stop'

function Resolve-StateDir {
  if ($StateDir) { return $StateDir }
  return (Join-Path $env:USERPROFILE '.dsh\desktop-app')
}

function Resolve-Browser {
  if ($Browser) { return $Browser }
  $candidates = New-Object System.Collections.ArrayList
  $roots = @(
    [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'),
    [Environment]::GetEnvironmentVariable('ProgramFiles'),
    [Environment]::GetEnvironmentVariable('LOCALAPPDATA')
  )
  foreach ($root in $roots) {
    if (-not $root) { continue }
    [void]$candidates.Add((Join-Path $root 'Microsoft\Edge\Application\msedge.exe'))
    [void]$candidates.Add((Join-Path $root 'Google\Chrome\Application\chrome.exe'))
  }
  foreach ($path in $candidates) {
    if (Test-Path $path) { return $path }
  }
  return $null
}

$StateDir = Resolve-StateDir
if (-not $Title) { $Title = 'DeepSeek Harness' }
if (-not $Browser) { $Browser = Resolve-Browser }
if (-not $Browser) {
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  Add-Content -Path (Join-Path $StateDir 'tray.log') -Value 'no chromium-family browser found; tray host cannot open a window' -Encoding UTF8
  exit 3
}

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

$logPath = Join-Path $StateDir 'tray.log'
$urlPath = Join-Path $StateDir 'tray-url.txt'
$serverLog = Join-Path $StateDir 'server.log'

function Write-TrayLog([string]$Message) {
  try {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -Path $logPath -Value $line -Encoding UTF8
  } catch { }
}

# Refresh tray-url.txt from the server log when the current copy is missing or has a
# token the server no longer accepts (every server restart mints a new token).
function Update-Url {
  try {
    if (-not (Test-Path $serverLog)) { return }
    $match = Select-String -Path $serverLog -Pattern 'http://\S+' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $match) { return }
    $url = $match.Matches[0].Value
    if ($url.Length -eq 0) { return }
    $current = if (Test-Path $urlPath) { (Get-Content -Raw $urlPath).Trim() } else { '' }
    if ($current -ne $url) {
      [System.IO.File]::WriteAllText($urlPath, $url, (New-Object System.Text.UTF8Encoding($false)))
      Write-TrayLog 'refreshed tray-url.txt from server.log'
    }
  } catch { }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# The generated launcher copies both files into the state directory and starts this
# script from there, so the companion C# sits next to the *script*; fall back to the
# state directory for the case where a caller passes -StateDir explicitly.
$csPath = Join-Path $PSScriptRoot 'tray-host.cs'
if (-not (Test-Path $csPath)) { $csPath = Join-Path $StateDir 'tray-host.cs' }
if (-not (Test-Path $csPath)) {
  Write-TrayLog "missing tray-host.cs (looked next to the script and in $StateDir)"
  exit 2
}

if (-not ('DshTrayHost' -as [type])) {
  $cs = [System.IO.File]::ReadAllText($csPath, [System.Text.Encoding]::UTF8)
  Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition $cs
}

Update-Url

# Single instance: signal the running host through a named mutex.
$mutex = New-Object System.Threading.Mutex($false, 'Global\DshTrayHost')
if (-not $mutex.WaitOne(0)) {
  Write-TrayLog 'another tray host is already running; exiting'
  exit 0
}

# NOTE: do NOT name this $host -- that is a read-only PowerShell automatic variable
# and assigning it aborts the script (same trap as $home earlier in this project).
if (-not $IconFile) {
  $candidate = Join-Path $StateDir 'tray.ico'
  if (Test-Path $candidate) { $IconFile = $candidate }
}

$tray = New-Object DshTrayHost($StateDir, $Browser, $Title, $IconFile)
$tray.Start()
Write-TrayLog "tray host running; state dir = $StateDir"

# Keep the URL fresh while resident: a restarted server mints a new token.
$urlTimer = New-Object System.Windows.Forms.Timer
$urlTimer.Interval = 60000
$urlTimer.Add_Tick({ Update-Url })
$urlTimer.Start()

[System.Windows.Forms.Application]::Run()
$urlTimer.Stop()
$mutex.ReleaseMutex()
Write-TrayLog 'tray host stopped'
