/**
 * dsh-desktop-app — pure logic layer.
 *
 * No DSH/cordis imports live here on purpose: this module is unit-testable on
 * its own and the plugin wiring in `index.js` stays a thin adapter.
 *
 * What it does: opens the DeepSeek Harness Web UI as a standalone desktop
 * window using a Chromium-family browser in `--app` mode (no tabs, no address
 * bar, its own taskbar entry), and installs/removes the Desktop shortcut that
 * launches it.
 *
 * @module dsh-desktop-app/desktop
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync, copyFileSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn, spawnSync } from 'node:child_process'

/** Where generated launchers live. Reused across installs. */
export const STATE_DIR = join(homedir(), '.dsh', 'desktop-app')
/** The generated PowerShell launcher (ASCII-only on purpose — see buildLauncher). */
export const LAUNCHER_PATH = join(STATE_DIR, 'launch.ps1')
/** The generated cmd file that starts the server (see buildStartCommand). */
export const START_CMD_PATH = join(STATE_DIR, 'start-server.cmd')
/** Launcher diagnostics log. */
export const LAUNCHER_LOG_PATH = join(STATE_DIR, 'launcher.log')
/** Captured server output, read for the tokenised boot URL. */
export const SERVER_LOG_PATH = join(STATE_DIR, 'server.log')
/** Generated detached restart helper (see buildRestartHelper). */
export const RESTART_HELPER_PATH = join(STATE_DIR, 'restart.ps1')
/** Restart helper diagnostics. */
export const RESTART_LOG_PATH = join(STATE_DIR, 'restart.log')
/** Tiny script that starts the restart helper OUTSIDE this server's job object. */
export const RESTART_LAUNCHER_PATH = join(STATE_DIR, 'restart-launch.ps1')
/**
 * Notification-area host shipped with this plugin.
 *
 * Why: the app window is a Chromium --app window, i.e. a browser page. A page cannot
 * minimise itself to the tray, and closing the window kills its process, so tray
 * residency needs a separate long-lived process. These files are copied into
 * {@link STATE_DIR} on install and started by the generated launcher.
 */
export const TRAY_PS1_PATH = join(STATE_DIR, 'tray-host.ps1')
export const TRAY_CS_PATH = join(STATE_DIR, 'tray-host.cs')
export const TRAY_CMD_PATH = join(STATE_DIR, 'tray-host.cmd')
/** Icon used for the notification-area entry (optional; browser icon as fallback). */
export const TRAY_ICON_PATH = join(STATE_DIR, 'tray.ico')
/** Tokenised boot URL handed to the tray host so it can reopen a closed window. */
export const TRAY_URL_PATH = join(STATE_DIR, 'tray-url.txt')
/** Tray host diagnostics. */
export const TRAY_LOG_PATH = join(STATE_DIR, 'tray.log')
/** Default shortcut file name on the Desktop. */
export const DEFAULT_SHORTCUT_NAME = 'DeepSeek Harness.lnk'

const IS_WINDOWS = platform() === 'win32'

/* ------------------------------------------------------------------ *
 * Browser discovery
 * ------------------------------------------------------------------ */

/**
 * Candidate Chromium-family browser locations for this platform, in the order
 * we prefer them (Edge first on Windows: it ships with the OS and is therefore
 * the one most likely to already hold the user's DSH cookie).
 *
 * @returns {Array<{id: string, label: string, path: string}>}
 */
export function browserCandidates() {
  const home = homedir()
  if (IS_WINDOWS) {
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const lad = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
    return [
      { id: 'edge', label: 'Microsoft Edge', path: join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { id: 'edge', label: 'Microsoft Edge', path: join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { id: 'edge', label: 'Microsoft Edge', path: join(lad, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { id: 'chrome', label: 'Google Chrome', path: join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { id: 'chrome', label: 'Google Chrome', path: join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { id: 'chrome', label: 'Google Chrome', path: join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { id: 'brave', label: 'Brave', path: join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
      { id: 'brave', label: 'Brave', path: join(lad, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
      { id: 'vivaldi', label: 'Vivaldi', path: join(lad, 'Vivaldi', 'Application', 'vivaldi.exe') },
      { id: 'opera', label: 'Opera', path: join(lad, 'Programs', 'Opera', 'opera.exe') },
    ]
  }
  if (platform() === 'darwin') {
    const app = (n) => join('/Applications', n, 'Contents', 'MacOS', n)
    return [
      { id: 'chrome', label: 'Google Chrome', path: app('Google Chrome') },
      { id: 'edge', label: 'Microsoft Edge', path: app('Microsoft Edge') },
      { id: 'brave', label: 'Brave', path: app('Brave Browser') },
      { id: 'vivaldi', label: 'Vivaldi', path: app('Vivaldi') },
    ]
  }
  return [
    { id: 'chrome', label: 'Google Chrome', path: '/usr/bin/google-chrome' },
    { id: 'chrome', label: 'Google Chrome', path: '/usr/bin/google-chrome-stable' },
    { id: 'chromium', label: 'Chromium', path: '/usr/bin/chromium' },
    { id: 'chromium', label: 'Chromium', path: '/usr/bin/chromium-browser' },
    { id: 'edge', label: 'Microsoft Edge', path: '/usr/bin/microsoft-edge' },
    { id: 'brave', label: 'Brave', path: '/usr/bin/brave-browser' },
  ]
}

/**
 * Installed Chromium-family browsers, de-duplicated by executable path.
 *
 * @returns {Array<{id: string, label: string, path: string}>}
 */
export function detectBrowsers() {
  const seen = new Set()
  const found = []
  for (const candidate of browserCandidates()) {
    const key = candidate.path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (existsSync(candidate.path)) found.push(candidate)
  }
  return found
}

/**
 * Pick the browser to drive. An explicit path always wins; otherwise the first
 * detected candidate is used.
 *
 * @param {string} [explicit] - User-supplied executable path or browser id.
 * @returns {{browser: {id: string, label: string, path: string} | null, error?: string}}
 */
export function resolveBrowser(explicit) {
  const installed = detectBrowsers()
  if (explicit) {
    if (explicit.includes('/') || explicit.includes('\\')) {
      if (!existsSync(explicit)) return { browser: null, error: `browser not found at ${explicit}` }
      const named = installed.find((b) => b.path.toLowerCase() === explicit.toLowerCase())
      return { browser: named ?? { id: 'custom', label: 'custom browser', path: explicit } }
    }
    const byId = installed.find((b) => b.id === explicit.toLowerCase())
    if (!byId) {
      return {
        browser: null,
        error: `no installed browser matches "${explicit}"; detected: ${installed.map((b) => b.id).join(', ') || 'none'}`,
      }
    }
    return { browser: byId }
  }
  if (installed.length === 0) {
    return { browser: null, error: 'no Chromium-family browser found (Edge, Chrome, Brave, Vivaldi and Opera were all checked)' }
  }
  return { browser: installed[0] }
}

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

/**
 * The user's Desktop directory, accounting for OneDrive folder redirection.
 *
 * @returns {string}
 */
export function resolveDesktopDir() {
  const home = homedir()
  const candidates = IS_WINDOWS
    ? [join(home, 'Desktop'), join(process.env['OneDrive'] ?? join(home, 'OneDrive'), 'Desktop'), join(process.env['OneDriveConsumer'] ?? '', 'Desktop')]
    : [join(home, 'Desktop')]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return join(home, 'Desktop')
}

/**
 * Absolute path of the Desktop shortcut this plugin manages.
 *
 * @param {string} [name] - Override the shortcut file name.
 * @returns {string}
 */
export function shortcutPath(name = DEFAULT_SHORTCUT_NAME) {
  return join(resolveDesktopDir(), name)
}

/* ------------------------------------------------------------------ *
 * Launcher generation
 * ------------------------------------------------------------------ */

/** Single-quote a value for embedding in a PowerShell single-quoted string. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Synchronous sleep without spawning a process to do it. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Build the `.cmd` file that starts the DSH server and captures its output.
 *
 * A file is used instead of `cmd /c "<quoted path>" ... > log`: when the first
 * character after `/c` is a quote, cmd.exe applies its quote-stripping rules and
 * the whole command (including the redirect) mis-parses. That failure is silent
 * — no output file is produced at all — which is exactly how a "clicked the icon
 * and nothing happened" bug reaches users. Reading the command from a file has
 * no such ambiguity.
 *
 * @param {{nodePath: string, dshBin: string, logPath: string}} options
 * @returns {string}
 */
export function buildStartCommand(options) {
  const { nodePath, dshBin, logPath } = options
  const win = (p) => (IS_WINDOWS ? String(p).replace(/\//g, '\\') : String(p))
  return [
    '@echo off',
    'rem Generated by dsh-desktop-app. Starts the DSH web server, output captured.',
    `"${win(nodePath)}" "${win(dshBin)}" web --no-open > "${win(logPath)}" 2>&1`,
    '',
  ].join('\r\n')
}

/**
 * Build the PowerShell launcher written to {@link LAUNCHER_PATH}.
 *
 * The output is intentionally **ASCII-only with no line-continuation pipes**:
 * Windows PowerShell 5.1 reads `.ps1` files using the ANSI code page unless the
 * file has a UTF-8 BOM, so non-ASCII can corrupt parsing. Keep it plain.
 *
 * Behaviour:
 *  - port already listening -> open the window, fast and silent;
 *  - otherwise              -> start {@link START_CMD_PATH} once (a second click
 *                              while it is starting waits instead of racing a
 *                              second server into a port conflict), show that
 *                              console as progress feedback, wait for the
 *                              listener, read the tokenised URL printed at boot,
 *                              and open that (visiting it mints the auth cookie,
 *                              so it works with no cookie yet);
 *  - never came up          -> log it and raise a message box rather than
 *                              failing silently.
 *
 * @param {{port: number, browserPath: string, startCmd: string, logPath: string, launcherLog: string}} options
 * @returns {string}
 */
export function buildLauncher(options) {
  const { port, browserPath, startCmd, logPath, launcherLog, stateDir, trayCmd } = options
  const win = (p) => (IS_WINDOWS ? String(p).replace(/\//g, '\\') : String(p))
  return `# Generated by dsh-desktop-app. Re-run the install action to regenerate.
# ASCII only on purpose: PowerShell 5.1 reads .ps1 using the ANSI code page
# unless the file carries a UTF-8 BOM, so non-ASCII text can break parsing.
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$port = ${Number(port)}
$browser = ${psQuote(win(browserPath))}
$startCmd = ${psQuote(win(startCmd))}
$log = ${psQuote(win(logPath))}
$myLog = ${psQuote(win(launcherLog))}
$stateDir = ${psQuote(win(stateDir))}
$trayCmd = ${psQuote(win(trayCmd))}
$trayUrl = Join-Path $stateDir 'tray-url.txt'

function Write-Log($m) {
  ((Get-Date).ToString('HH:mm:ss') + '  ' + $m) | Out-File -FilePath $myLog -Append -Encoding utf8
}

# The tray host stays resident so the app can be minimised to the notification
# area and the window can be reopened after it is closed. Start it BEFORE the
# window so closing the window never leaves the user with nothing.
#
# No "is it already running?" pre-check on purpose. Matching another process by
# command line proved unreliable: any caller whose own command line merely mentions
# tray-host.ps1 (an installer run, a debugging shell) made the launcher skip
# starting one, and the user was left with no tray icon. The tray script itself owns
# a named mutex and exits immediately when a host is already live, so starting it
# unconditionally is both simpler and correct.
function Start-TrayHost {
  if (-not (Test-Path $trayCmd)) { Write-Log 'tray cmd missing; skipping tray host'; return }
  Start-Process -FilePath $trayCmd -WindowStyle Hidden
  Write-Log 'tray host start requested'
}

function Test-Listening {
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  return [bool]$conn
}

function Test-Starting {
  $needle = $startCmd.ToLower()
  $procs = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    if ($p.CommandLine -and $p.CommandLine.ToLower().Contains($needle)) { return $true }
  }
  return $false
}

# A cold start takes tens of seconds, so say something rather than leaving the
# user staring at nothing. A tray balloon is used instead of a console window:
# the server's own console has its output redirected to the log, so showing it
# would only ever display an empty black window.
$script:tip = $null

function Show-Progress($text) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $script:tip = New-Object System.Windows.Forms.NotifyIcon
    $script:tip.Icon = [System.Drawing.SystemIcons]::Information
    $script:tip.Visible = $true
    $script:tip.ShowBalloonTip(15000, 'DeepSeek Harness', $text, [System.Windows.Forms.ToolTipIcon]::Info)
  } catch {
  }
}

function Hide-Progress {
  try {
    if ($script:tip) { $script:tip.Visible = $false; $script:tip.Dispose(); $script:tip = $null }
  } catch {
  }
}

Write-Log '--- launcher start ---'
$url = 'http://127.0.0.1:' + $port + '/'

if (-not (Test-Listening)) {
  $busy = Test-Starting
  Write-Log ('server not listening; already-starting=' + $busy)
  if (-not $busy) {
    if (Test-Path $log) { Remove-Item $log -Force }
    Start-Process -FilePath $startCmd -WindowStyle Hidden
    Write-Log 'started the server hidden; its output goes to the log'
    Show-Progress 'Starting the local server, please wait...'
  }
  for ($i = 0; $i -lt 240; $i++) {
    if (Test-Listening) { break }
    Start-Sleep -Milliseconds 500
  }
  Write-Log ('listening=' + (Test-Listening) + ' after ' + ($i * 0.5) + 's')
} else {
  Write-Log 'server already listening; opening directly'
}

# Always (re)read the tokenised boot URL from the server log, whichever branch ran.
# A server that was already listening has long since printed its URL, and each start
# mints a NEW token, so a hard-coded or stale value would make the tray host reopen a
# window that lands on 401. This loop also covers the cold-start case above.
$url = ''
for ($j = 0; $j -lt 60; $j++) {
  if (Test-Path $log) {
    $hits = Select-String -Path $log -Pattern 'dsh web:\\s*(http://\\S+)' -ErrorAction SilentlyContinue
    $first = $hits | Select-Object -First 1
    if ($first) {
      $url = $first.Matches[0].Groups[1].Value
      break
    }
  }
  Start-Sleep -Milliseconds 500
}
Write-Log ('url = ' + $url)

if (-not (Test-Listening)) {
  Write-Log 'FAILED: the server did not start in time'
  Hide-Progress
  Add-Type -AssemblyName System.Windows.Forms
  $msg = 'DeepSeek Harness did not start within two minutes.' + [Environment]::NewLine + [Environment]::NewLine + 'Run the desktop_app status action, or read the launcher log.'
  [void][System.Windows.Forms.MessageBox]::Show($msg, 'DeepSeek Harness', 'OK', 'Warning')
  exit 1
}

Hide-Progress

# Record the tokenised URL first: the tray host reads it to reopen the window
# later (a restarted server mints a new token, so it is rewritten every launch).
if ($url) {
  [System.IO.File]::WriteAllText($trayUrl, $url, (New-Object System.Text.UTF8Encoding($false)))
  Write-Log ('tray url recorded: ' + $url)
}

Start-TrayHost
Start-Process -FilePath $browser -ArgumentList ('--app=' + $url)
Write-Log 'opened app window'
`;
}

/**
 * Build the detached restart helper written to {@link RESTART_HELPER_PATH}.
 *
 * A restart cannot run inside the process being restarted, so this script is
 * spawned detached: it waits, stops whatever holds the port, waits for the
 * release, relaunches through the launcher, and falls back to a visible console
 * if the launcher does not bring the server up — the user must never be left
 * with nothing. ASCII-only for the same reason as the launcher.
 *
 * @param {{port: number, launcherPath: string, npxPath: string, logPath: string, delaySeconds: number}} options
 * @returns {string}
 */
export function buildRestartHelper(options) {
  const {
    port,
    launcherPath,
    npxPath: npx,
    logPath,
    delaySeconds,
    closeOldWindows = false,
    windowTitleMarker = 'DeepSeek Harness',
    windowTitleExcludes = [],
  } = options
  const win = (p) => (IS_WINDOWS ? String(p).replace(/\//g, '\\') : String(p))
  const psBool = (v) => (v ? '$true' : '$false')
  const psArray = (list) => `@(${list.map((v) => psQuote(v)).join(', ')})`
  return `# Generated by dsh-desktop-app (restart action). ASCII only on purpose:
# PowerShell 5.1 decodes a BOM-less .ps1 using the ANSI code page, so a
# non-ASCII byte here would be a latent parse failure.
$log = ${psQuote(win(logPath))}
function Write-Log($m) {
  ((Get-Date).ToString('HH:mm:ss') + '  ' + $m) | Out-File -FilePath $log -Append -Encoding utf8
}

$port = ${Number(port)}
$launcher = ${psQuote(win(launcherPath))}
$npx = ${psQuote(win(npx))}
$workdir = ${psQuote(dirnameOf(win(npx)))}
$closeOldWindows = ${psBool(closeOldWindows)}
$titleMarker = ${psQuote(windowTitleMarker)}
$titleExcludes = ${psArray(windowTitleExcludes)}

$script:winApiReady = $false
if ($closeOldWindows) {
  try {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class DshWinScan {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static List<string> Find(string marker, string[] excludes) {
    var r = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      var t = sb.ToString();
      if (t.Length == 0 || !t.Contains(marker)) return true;
      foreach (var e in excludes) { if (t.Contains(e)) return true; }
      r.Add(h.ToInt64() + "|" + t);
      return true;
    }, IntPtr.Zero);
    return r;
  }
  public static void Close(long h) { PostMessage(new IntPtr(h), 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
'@
    $script:winApiReady = $true
  } catch {
    Write-Log ('window api unavailable: ' + $_.Exception.Message)
  }
}

Write-Log ('--- restart helper start (pid ' + $PID + '), waiting ${Number(delaySeconds)}s ---')
Start-Sleep -Seconds ${Number(delaySeconds)}

# 1. stop whatever holds the port
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  $conn.OwningProcess | Select-Object -Unique | ForEach-Object {
    Write-Log ('stopping pid ' + $_)
    Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
  }
} else {
  Write-Log 'nothing was listening'
}

# 1b. close the now-dead DSH windows.
#
# This runs BEFORE the new server starts, which is what makes it deterministic:
# with the server stopped, every DSH app window on screen is by definition
# showing a dead page, and the replacement window cannot exist yet. An earlier
# version waited for a "new" window handle to appear first, which proved
# unreliable - Chromium sometimes focuses or reuses the existing app window, so
# no new handle showed up and nothing was closed.
if ($closeOldWindows -and $winApiReady) {
  try {
    $stale = [DshWinScan]::Find($titleMarker, $titleExcludes)
    Write-Log ('closing ' + $stale.Count + ' stale DSH window(s)')
    foreach ($w in $stale) {
      # Use the literal .NET split. Do not reach for -split here: this whole file
      # is a JS template literal, and JS drops the backslash in an unrecognised
      # escape, so -split '\\|' was emitted as -split '|' - a regex meaning "split
      # on empty", which yielded empty handles and closed nothing at all.
      $hnd = $w.Split('|')[0]
      Write-Log ('  close ' + $hnd)
      try { [DshWinScan]::Close([long]$hnd) } catch { Write-Log ('    close failed: ' + $_.Exception.Message) }
    }
  } catch {
    Write-Log ('closing stale windows failed: ' + $_.Exception.Message)
  }
}

# 2. wait for the port to be released
$free = $false
for ($i = 0; $i -lt 60; $i++) {
  if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { $free = $true; break }
  Start-Sleep -Milliseconds 500
}
Write-Log ('port free: ' + $free)

# 3. relaunch through the launcher (hidden console + app window)
if (Test-Path $launcher) {
  Write-Log 'running the launcher'
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList '-NoLogo', '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $launcher
} else {
  Write-Log 'launcher missing; starting with a visible console'
  Start-Process -FilePath $npx -ArgumentList '--verbose', '@deepseek-ai/dsh web' -WorkingDirectory $workdir -WindowStyle Normal
}

# 4. confirm it came back, otherwise fall back so the user is never stuck
$up = $false
for ($i = 0; $i -lt 120; $i++) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
  Start-Sleep -Seconds 1
}
if ($up) {
  Write-Log ('server is listening again after ' + $i + 's')
  exit 0
}
Write-Log 'the launcher did not bring the server up; falling back to a visible console'
Start-Process -FilePath $npx -ArgumentList '--verbose', '@deepseek-ai/dsh web' -WorkingDirectory $workdir -WindowStyle Normal
exit 0
`;
}

/* ------------------------------------------------------------------ *
 * Windows shortcut creation
 * ------------------------------------------------------------------ */

/**
 * Run a PowerShell script supplied as a temporary file.
 *
 * The file is written **with a UTF-8 BOM on purpose**. PowerShell 5.1 decodes a
 * BOM-less `.ps1` using the ANSI code page, which silently mangles any non-ASCII
 * path in the script — an icon path like `C:\Users\x\Pictures\<non-ASCII>\a.ico`
 * comes back corrupted and Windows falls back to a default icon. The BOM makes
 * the encoding explicit. (The generated launcher is a different case: it is kept
 * ASCII-only, so it needs no BOM.)
 */
function runPowerShellFile(script) {
  const file = join(tmpdir(), `dsh-desktop-app-${Date.now()}-${process.pid}.ps1`)
  writeFileSync(file, `\uFEFF${script}`, 'utf8')
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8', timeout: 60000, windowsHide: true },
    )
    return { ok: true, output: (out ?? '').trim() }
  } catch (error) {
    return { ok: false, output: String(error?.stderr ?? error?.message ?? error).trim() }
  } finally {
    try {
      unlinkSync(file)
    } catch {
      /* best effort */
    }
  }
}

/**
 * Create (or overwrite) the Windows Desktop shortcut.
 *
 * @param {{shortcut: string, launcher: string, icon?: string}} options
 * @returns {{ok: boolean, output: string}}
 */
export function createWindowsShortcut(options) {
  const { shortcut, launcher, icon } = options
  const ps = IS_WINDOWS
    ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
  const args = `-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${launcher}"`
  const iconLine = icon
    ? `$lnk.IconLocation = ${psQuote(icon)}`
    : `$lnk.IconLocation = ${psQuote(ps)}`
  const script = `$ErrorActionPreference = 'Stop'
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut(${psQuote(shortcut)})
$lnk.TargetPath = ${psQuote(ps)}
$lnk.Arguments = ${psQuote(args)}
$lnk.WorkingDirectory = ${psQuote(dirnameOf(launcher))}
${iconLine}
$lnk.Description = 'DeepSeek Harness desktop app'
$lnk.Save()
Write-Output 'shortcut-ok'
`
  return runPowerShellFile(script)
}

function dirnameOf(file) {
  const idx = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'))
  return idx > 0 ? file.slice(0, idx) : file
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} ActionContext
 * @property {number} port - The live DSH Web port.
 * @property {string} [browser] - Explicit browser path or id.
 * @property {string} [icon] - Optional .ico path for the shortcut.
 * @property {string} [shortcutName] - Optional shortcut file name.
 * @property {string} [baseUrl] - Canonical base URL (defaults to http://127.0.0.1:<port>/).
 * @property {string} [authenticatedUrl] - Tokenised URL, when the host can mint one.
 * @property {string} nodePath - Absolute path of the Node executable running DSH.
 * @property {string} dshBin - Absolute path of the DSH CLI entry (bin.js).
 */

function resolveRuntime(ctx) {
  const port = Number(ctx?.port)
  if (!Number.isInteger(port) || port <= 0) throw new Error('dsh-desktop-app: could not determine the DSH web port')
  const browser = resolveBrowser(ctx?.browser)
  return { port, browser, nodePath: ctx?.nodePath ?? process.execPath, dshBin: ctx?.dshBin }
}

/**
 * Report what the plugin can see and whether the shortcut is installed.
 *
 * @param {ActionContext} ctx
 * @returns {object}
 */
export function actionStatus(ctx) {
  const { port, browser } = resolveRuntime(ctx)
  const desktop = resolveDesktopDir()
  const shortcut = shortcutPath(ctx?.shortcutName)
  const installedBrowsers = detectBrowsers()
  return {
    platform: platform(),
    port,
    baseUrl: ctx?.baseUrl ?? `http://127.0.0.1:${port}/`,
    desktop,
    shortcut,
    shortcutInstalled: existsSync(shortcut),
    launcher: LAUNCHER_PATH,
    launcherInstalled: existsSync(LAUNCHER_PATH),
    startCmd: START_CMD_PATH,
    startCmdInstalled: existsSync(START_CMD_PATH),
    trayCmd: TRAY_CMD_PATH,
    trayInstalled: existsSync(TRAY_CMD_PATH) && existsSync(TRAY_PS1_PATH) && existsSync(TRAY_CS_PATH),
    trayIcon: existsSync(TRAY_ICON_PATH) ? TRAY_ICON_PATH : null,
    launcherLog: LAUNCHER_LOG_PATH,
    browser: browser.browser ? { id: browser.browser.id, label: browser.browser.label, path: browser.browser.path } : null,
    browserError: browser.error,
    installedBrowsers: installedBrowsers.map((b) => ({ id: b.id, label: b.label, path: b.path })),
    nodePath: ctx?.nodePath ?? process.execPath,
    dshBin: ctx?.dshBin ?? null,
  }
}

/**
 * Write the launcher and the start command.
 *
 * Shared by `install` and `restart` on purpose: both must always run the same
 * generated code, so a fix to one can never leave the other stale.
 *
 * @param {ActionContext} ctx
 * @returns {{port: number, browser: {browser: object}, nodePath: string, dshBin: string}}
 */
function writeLauncherArtifacts(ctx) {
  const { port, browser, nodePath, dshBin } = resolveRuntime(ctx)
  if (!browser.browser) throw new Error(`dsh-desktop-app: ${browser.error}`)
  if (!IS_WINDOWS) {
    throw new Error(
      `dsh-desktop-app: launcher generation currently supports Windows only (detected ${platform()}). ` +
        'Use the open action, or launch: ' +
        `${browser.browser.path} --app=http://127.0.0.1:${port}/`,
    )
  }
  if (!dshBin || !existsSync(dshBin)) {
    throw new Error('dsh-desktop-app: could not locate the DSH CLI entry point; cannot record a start command')
  }

  mkdirSync(STATE_DIR, { recursive: true })
  const startCmd = buildStartCommand({ nodePath, dshBin, logPath: SERVER_LOG_PATH })
  const launcher = buildLauncher({
    port,
    browserPath: browser.browser.path,
    startCmd: START_CMD_PATH,
    logPath: SERVER_LOG_PATH,
    launcherLog: LAUNCHER_LOG_PATH,
    stateDir: STATE_DIR,
    trayCmd: TRAY_CMD_PATH,
  })
  // PowerShell 5.1 and cmd.exe both read these files using the ANSI code page
  // unless a BOM is present, so any non-ASCII byte is a latent parse failure.
  for (const [label, content] of [['start-server.cmd', startCmd], ['launch.ps1', launcher]]) {
    if (/[^\x00-\x7F]/.test(content)) {
      throw new Error(`dsh-desktop-app: generated ${label} is not ASCII; refusing to write it`)
    }
  }
  writeFileSync(START_CMD_PATH, startCmd, 'utf8')
  writeFileSync(LAUNCHER_PATH, launcher, 'utf8')
  installTrayHostFiles({ icon: ctx?.trayIcon })
  return { port, browser, nodePath, dshBin }
}

/**
 * Copy one file, tolerating the Windows quirks around overwriting.
 *
 * `copyFileSync` over an existing destination can fail with EPERM (the destination
 * inherits its ACL) and a freshly written .exe/.ico may be briefly held by an
 * indexer or antivirus. Deleting first and retrying a few times makes a reinstall
 * idempotent instead of failing the whole install.
 *
 * @param {string} from - source path
 * @param {string} to - destination path
 */
function copyTolerantly(from, to) {
  let lastError
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (existsSync(to)) rmSync(to, { force: true })
      copyFileSync(from, to)
      return
    } catch (error) {
      lastError = error
      // Busy-wait briefly; the holder is normally a file indexer.
      const until = Date.now() + 120 * (attempt + 1)
      while (Date.now() < until) { /* spin */ }
    }
  }
  throw new Error(`dsh-desktop-app: could not install ${to}: ${lastError?.message ?? 'unknown error'}`)
}

/**
 * Copy the notification-area host files into {@link STATE_DIR}.
 *
 * Everything the tray host needs must sit next to each other in the state directory:
 * the .ps1 resolves its C# companion through its own directory, and the generated
 * launcher starts the .cmd from there. The state directory is a plain ASCII path
 * (`~/.dsh/desktop-app`), which is deliberate — a CJK script path gets mangled when
 * PowerShell 5.1 reads the file as ANSI.
 *
 * @param {{icon?: string}} [options] - optional custom .ico to install as tray.ico
 * @returns {{copied: string[], icon: string | null}}
 */
export function installTrayHostFiles(options = {}) {
  const sourceDir = dirname(fileURLToPath(import.meta.url))
  mkdirSync(STATE_DIR, { recursive: true })
  const copied = []
  for (const [from, to] of [
    ['tray-host.ps1', TRAY_PS1_PATH],
    ['tray-host.cs', TRAY_CS_PATH],
    ['tray-host.cmd', TRAY_CMD_PATH],
  ]) {
    const source = join(sourceDir, from)
    if (!existsSync(source)) {
      throw new Error(`dsh-desktop-app: missing tray host asset ${from} next to lib/desktop.js`)
    }
    copyTolerantly(source, to)
    copied.push(to)
  }

  let icon = null
  const requested = options.icon ?? join(sourceDir, 'tray.ico')
  if (existsSync(requested)) {
    copyTolerantly(requested, TRAY_ICON_PATH)
    icon = TRAY_ICON_PATH
    copied.push(TRAY_ICON_PATH)
  }
  return { copied, icon }
}

/**
 * Stop a running notification-area host.
 *
 * Matched by command line (`tray-host`) because the host is a plain PowerShell
 * process with no window; it is started detached so nothing else tracks it.
 *
 * @returns {number} how many processes were stopped
 */
export function stopTrayHost() {
  if (!IS_WINDOWS) return 0
  let stopped = 0
  try {
    const listing = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | " +
          "Where-Object { $_.CommandLine -like '*tray-host*' } | " +
          'ForEach-Object { $_.ProcessId }',
      ],
      { encoding: 'utf8' },
    )
    for (const line of listing.split(/\r?\n/)) {
      const pid = Number(line.trim())
      if (!Number.isFinite(pid) || pid <= 0) continue
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' })
        stopped += 1
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no PowerShell or nothing to stop */
  }
  return stopped
}

/**
 * Generate the launcher and create the Desktop shortcut.
 *
 * @param {ActionContext} ctx
 * @returns {object}
 */
export function actionInstall(ctx) {
  const { port, browser, nodePath, dshBin } = writeLauncherArtifacts(ctx)

  const shortcut = shortcutPath(ctx?.shortcutName)
  const created = createWindowsShortcut({
    shortcut,
    launcher: LAUNCHER_PATH,
    icon: ctx?.icon,
  })
  if (!created.ok || !existsSync(shortcut)) {
    throw new Error(`dsh-desktop-app: could not create the shortcut: ${created.output || 'unknown error'}`)
  }

  return {
    installed: true,
    shortcut,
    launcher: LAUNCHER_PATH,
    startCmd: START_CMD_PATH,
    launcherLog: LAUNCHER_LOG_PATH,
    serverLog: SERVER_LOG_PATH,
    browser: browser.browser.path,
    port,
    startCommand: `"${nodePath}" "${dshBin}" web --no-open`,
  }
}

/**
 * Remove the Desktop shortcut and the generated launcher.
 *
 * @param {ActionContext} ctx
 * @returns {object}
 */
export function actionRemove(ctx) {
  const shortcut = shortcutPath(ctx?.shortcutName)
  const removed = []
  if (existsSync(shortcut)) {
    rmSync(shortcut, { force: true })
    removed.push(shortcut)
  }
  // Stop the tray host first: it would otherwise keep running (and keep the
  // server alive) after its files are deleted.
  stopTrayHost()
  for (const file of [
    LAUNCHER_PATH,
    START_CMD_PATH,
    TRAY_PS1_PATH,
    TRAY_CS_PATH,
    TRAY_CMD_PATH,
    TRAY_URL_PATH,
    TRAY_ICON_PATH,
  ]) {
    if (existsSync(file)) {
      rmSync(file, { force: true })
      removed.push(file)
    }
  }
  return { removed, shortcut, stillInstalled: existsSync(shortcut) }
}

/** Path of the npx shim shipped next to the running Node executable. */
function resolveNpxPath() {
  return join(dirnameOf(process.execPath), IS_WINDOWS ? 'npx.cmd' : 'npx')
}

/**
 * Build the script that starts {@link RESTART_HELPER_PATH} outside this server's
 * job object.
 *
 * A plain `child_process.spawn` is not enough here. This server manages its
 * children through a Windows job object, so a spawned helper inherits job
 * membership and is torn down with it — observed in practice as a process that
 * appears and then exits before executing a single line. `Win32_Process.Create`
 * parents the new process to `WmiPrvSE.exe` instead, which is outside the job;
 * that is the mechanism verified to survive.
 *
 * @param {{helperPath: string, logPath: string}} options
 * @returns {string}
 */
export function buildRestartLauncher(options) {
  const { helperPath, logPath } = options
  const win = (p) => (IS_WINDOWS ? String(p).replace(/\//g, '\\') : String(p))
  const helperCmd =
    `powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${win(helperPath)}"`
  return `# Generated by dsh-desktop-app (restart action). ASCII only on purpose.
$log = ${psQuote(win(logPath))}
function Write-Log($m) {
  ((Get-Date).ToString('HH:mm:ss') + '  ' + $m) | Out-File -FilePath $log -Append -Encoding utf8
}
$cmdLine = ${psQuote(helperCmd)}
try {
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine }
} catch {
  Write-Log ('WMI launch threw: ' + $_.Exception.Message)
  Write-Output 'ERROR'
  exit 1
}
if ($r.ReturnValue -ne 0) {
  Write-Log ('WMI launch refused, ReturnValue=' + $r.ReturnValue)
  Write-Output 'ERROR'
  exit 1
}
Write-Output $r.ProcessId
`;
}

/**
 * Restart the DSH server that is hosting this session.
 *
 * The work cannot happen in-process: the port has to be free before the new
 * server can bind, and the process doing the killing is the one being killed.
 * So a helper is written and started through {@link RESTART_LAUNCHER_PATH},
 * which creates it outside this server's job object.
 *
 * The launch is then **verified**: the action refuses to report success unless
 * the helper actually started. An earlier version spawned the helper directly
 * and reported "restart scheduled" while the process was being torn down
 * immediately — a silent lie is worse than a loud failure.
 *
 * @param {ActionContext & {delaySeconds?: number}} ctx
 * @returns {object}
 */
export function actionRestart(ctx) {
  const { port } = writeLauncherArtifacts(ctx)
  const raw = Number(ctx?.delaySeconds ?? 15)
  const delaySeconds = Number.isFinite(raw) ? Math.max(0, Math.min(Math.trunc(raw), 300)) : 15

  const helper = buildRestartHelper({
    port,
    launcherPath: LAUNCHER_PATH,
    npxPath: resolveNpxPath(),
    logPath: RESTART_LOG_PATH,
    delaySeconds,
    closeOldWindows: ctx?.closeOldWindows !== false,
    windowTitleMarker: 'DeepSeek Harness',
    // A Chromium app-mode window's title is just the page title. A normal
    // browser window appends the profile and browser name, and a window with
    // more than one tab also says so. Closing one of those would take the
    // user's unrelated tabs with it, so both shapes must be excluded.
    //
    // Note 'Microsoft' rather than 'Microsoft Edge': the real Edge title
    // contains a character that console rendering shows as '?' (observed as
    // "Microsoft? Edge"), so matching the exact browser name is not reliable.
    // Every entry here must stay ASCII — the generated helper is ASCII-guarded.
    windowTitleExcludes: ['Microsoft', 'Google', 'Edge', 'Chrome', 'Chromium', 'Brave', 'Vivaldi', 'Opera', 'Firefox'],
  })
  const launcher = buildRestartLauncher({ helperPath: RESTART_HELPER_PATH, logPath: RESTART_LOG_PATH })
  for (const [label, content] of [['restart.ps1', helper], ['restart-launch.ps1', launcher]]) {
    if (/[^\x00-\x7F]/.test(content)) {
      throw new Error(`dsh-desktop-app: generated ${label} is not ASCII; refusing to write it`)
    }
  }

  // The log is the proof of life, so clear it: a stale file must never be
  // mistaken for the new helper running.
  if (existsSync(RESTART_LOG_PATH)) rmSync(RESTART_LOG_PATH, { force: true })
  writeFileSync(RESTART_HELPER_PATH, helper, 'utf8')
  writeFileSync(RESTART_LAUNCHER_PATH, launcher, 'utf8')

  const launch = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', RESTART_LAUNCHER_PATH],
    { encoding: 'utf8', timeout: 30000, windowsHide: true },
  )
  const reported = String(launch.stdout ?? '').trim()
  const helperPid = Number(reported)
  const launched = launch.status === 0 && Number.isInteger(helperPid) && helperPid > 0

  // Confirm the helper is really alive before claiming anything.
  let confirmed = false
  for (let i = 0; i < 20; i++) {
    if (existsSync(RESTART_LOG_PATH)) {
      let text = ''
      try {
        text = readFileSync(RESTART_LOG_PATH, 'utf8')
      } catch {
        /* still being written */
      }
      if (text.includes('restart helper start')) {
        confirmed = true
        break
      }
    }
    sleepSync(250)
  }

  if (!launched || !confirmed) {
    throw new Error(
      'dsh-desktop-app: could not start the restart helper' +
        (launch.error ? ` (${launch.error.message})` : '') +
        `. Reported pid: ${reported || 'none'}; launcher stderr: ${String(launch.stderr ?? '').trim() || 'none'}. ` +
        `The server was NOT restarted. Inspect ${RESTART_LOG_PATH} and ${RESTART_LAUNCHER_PATH}.`,
    )
  }

  return {
    restarting: true,
    port,
    delaySeconds,
    helperPid,
    helper: RESTART_HELPER_PATH,
    launchScript: RESTART_LAUNCHER_PATH,
    log: RESTART_LOG_PATH,
    launcher: LAUNCHER_PATH,
    verified: true,
    note: `helper verified running (pid ${helperPid}); this session's server stops in about ${delaySeconds}s and the app window reopens by itself`,
  }
}

/**
 * Open the app window right now.
 *
 * @param {ActionContext} ctx
 * @returns {object}
 */
export function actionOpen(ctx) {
  const { port, browser } = resolveRuntime(ctx)
  if (!browser.browser) throw new Error(`dsh-desktop-app: ${browser.error}`)
  const url = ctx?.authenticatedUrl ?? ctx?.baseUrl ?? `http://127.0.0.1:${port}/`
  const child = spawn(browser.browser.path, [`--app=${url}`], { detached: true, stdio: 'ignore' })
  child.unref()
  return { opened: true, browser: browser.browser.path, url }
}

/**
 * Dispatch one action by name.
 *
 * @param {'status'|'install'|'remove'|'open'} action
 * @param {ActionContext} ctx
 * @returns {object}
 */
export function runAction(action, ctx) {
  switch (action) {
    case 'status': return { action, ...actionStatus(ctx) }
    case 'install': return { action, ...actionInstall(ctx) }
    case 'remove': return { action, ...actionRemove(ctx) }
    case 'restart': return { action, ...actionRestart(ctx) }
    case 'open': return { action, ...actionOpen(ctx) }
    default: throw new Error(`dsh-desktop-app: unknown action "${action}"`)
  }
}
