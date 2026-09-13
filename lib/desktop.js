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

import { existsSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

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
  const { port, browserPath, startCmd, logPath, launcherLog } = options
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

function Write-Log($m) {
  ((Get-Date).ToString('HH:mm:ss') + '  ' + $m) | Out-File -FilePath $myLog -Append -Encoding utf8
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

Write-Log '--- launcher start ---'
$url = 'http://127.0.0.1:' + $port + '/'

if (-not (Test-Listening)) {
  $busy = Test-Starting
  Write-Log ('server not listening; already-starting=' + $busy)
  if (-not $busy) {
    if (Test-Path $log) { Remove-Item $log -Force }
    Start-Process -FilePath $startCmd -WindowStyle Normal
    Write-Log 'started the server; its console window shows progress'
  }
  for ($i = 0; $i -lt 240; $i++) {
    if (Test-Listening) { break }
    Start-Sleep -Milliseconds 500
  }
  Write-Log ('listening=' + (Test-Listening) + ' after ' + ($i * 0.5) + 's')
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
} else {
  Write-Log 'server already listening; opening directly'
}

if (-not (Test-Listening)) {
  Write-Log 'FAILED: the server did not start in time'
  Add-Type -AssemblyName System.Windows.Forms
  $msg = 'DeepSeek Harness did not start within two minutes.' + [Environment]::NewLine + [Environment]::NewLine + 'Run the desktop_app status action, or read the launcher log.'
  [void][System.Windows.Forms.MessageBox]::Show($msg, 'DeepSeek Harness', 'OK', 'Warning')
  exit 1
}

Start-Process -FilePath $browser -ArgumentList ('--app=' + $url)
Write-Log 'opened app window'
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
    launcherLog: LAUNCHER_LOG_PATH,
    browser: browser.browser ? { id: browser.browser.id, label: browser.browser.label, path: browser.browser.path } : null,
    browserError: browser.error,
    installedBrowsers: installedBrowsers.map((b) => ({ id: b.id, label: b.label, path: b.path })),
    nodePath: ctx?.nodePath ?? process.execPath,
    dshBin: ctx?.dshBin ?? null,
  }
}

/**
 * Generate the launcher and create the Desktop shortcut.
 *
 * @param {ActionContext} ctx
 * @returns {object}
 */
export function actionInstall(ctx) {
  const { port, browser, nodePath, dshBin } = resolveRuntime(ctx)
  if (!browser.browser) throw new Error(`dsh-desktop-app: ${browser.error}`)
  if (!IS_WINDOWS) {
    throw new Error(
      `dsh-desktop-app: shortcut installation currently supports Windows only (detected ${platform()}). ` +
        'Use the open action, or create a shortcut to: ' +
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
  for (const file of [LAUNCHER_PATH, START_CMD_PATH]) {
    if (existsSync(file)) {
      rmSync(file, { force: true })
      removed.push(file)
    }
  }
  return { removed, shortcut, stillInstalled: existsSync(shortcut) }
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
    case 'open': return { action, ...actionOpen(ctx) }
    default: throw new Error(`dsh-desktop-app: unknown action "${action}"`)
  }
}
