/**
 * dsh-desktop-app — cordis plugin entry.
 *
 * Registers one host tool, `desktop_app`, that opens the DeepSeek Harness Web UI
 * as a standalone desktop window (Chromium `--app` mode) and manages the Desktop
 * shortcut that launches it.
 *
 * All real work lives in `./desktop.js`, which has no DSH imports so it can be
 * unit-tested on its own.
 *
 * @module dsh-desktop-app
 */

import { existsSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runAction } from './desktop.js'

/** Cordis plugin name. */
export const name = 'dsh-desktop-app'

/** Services required before this plugin activates. */
export const inject = ['tools', 'webServer']

/**
 * Reconstruct how this DSH server was started, so the generated launcher can
 * bring it back up when the shortcut is used while nothing is listening.
 *
 * The live process is `node <...>/@deepseek-ai/dsh/lib/bin.js web`, which is
 * exactly the shape we want to replay (plus `--no-open`).
 *
 * `process.argv[1]` is only trusted when it actually looks like the DSH CLI:
 * under an embedding host it can be anything, and baking a wrong start command
 * into the launcher would fail silently at first use.
 *
 * @returns {{nodePath: string, dshBin: string | null}}
 */
function resolveStartCommand() {
  const nodePath = process.execPath
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry.length === 0) return { nodePath, dshBin: null }
  const lower = entry.toLowerCase()
  const looksLikeDshCli = lower.endsWith('.js') && (lower.includes('@deepseek-ai') || lower.includes('dsh'))
  if (!looksLikeDshCli || !existsSync(entry)) return { nodePath, dshBin: null }
  return { nodePath, dshBin: entry }
}

/** Collect the runtime facts the action layer needs. */
function buildContext(ctx, args) {
  const { nodePath, dshBin } = resolveStartCommand()
  const port = ctx.webServer?.port
  const baseUrl = `http://127.0.0.1:${port}/`

  // `connection` may be absent outside the web profile; it is only needed to
  // mint a tokenised URL for `open`.
  let authenticatedUrl
  const connection = ctx.get?.('connection')
  if (connection?.authenticatedUrl) {
    try {
      authenticatedUrl = connection.authenticatedUrl(baseUrl)
    } catch {
      /* fall back to the plain URL */
    }
  }

  return {
    port,
    nodePath,
    dshBin,
    baseUrl,
    authenticatedUrl,
    browser: args?.browser,
    icon: args?.icon,
    shortcutName: args?.shortcutName,
    delaySeconds: args?.delaySeconds,
    closeOldWindows: args?.closeOldWindows,
  }
}

/** Human-readable rendering of one action result. */
function renderReport(value) {
  const lines = [`desktop_app -> ${value.action}`]
  if (value.action === 'status') {
    lines.push(
      `  platform        : ${value.platform}`,
      `  web port        : ${value.port}`,
      `  base URL        : ${value.baseUrl}`,
      `  browser         : ${value.browser ? `${value.browser.label} (${value.browser.path})` : `NOT FOUND — ${value.browserError ?? 'unknown reason'}`}`,
      `  other browsers  : ${value.installedBrowsers.filter((b) => !value.browser || b.path !== value.browser.path).map((b) => b.id).join(', ') || 'none'}`,
      `  desktop dir     : ${value.desktop}`,
      `  shortcut        : ${value.shortcut} ${value.shortcutInstalled ? '[installed]' : '[not installed]'}`,
      `  launcher        : ${value.launcher} ${value.launcherInstalled ? '[present]' : '[absent]'}`,
      `  start cmd file  : ${value.startCmd} ${value.startCmdInstalled ? '[present]' : '[absent]'}`,
      `  tray host       : ${value.trayCmd} ${value.trayInstalled ? '[present]' : '[absent]'}`,
      `  tray icon       : ${value.trayIcon ? value.trayIcon : '(browser icon fallback)'}`,
      `  launcher log    : ${value.launcherLog}`,
      `  dsh entry       : ${value.dshBin ?? 'unresolved'}`,
    )
    return lines.join('\n')
  }
  if (value.action === 'install') {
    lines.push(
      '  Desktop shortcut created.',
      `  shortcut    : ${value.shortcut}`,
      `  launcher    : ${value.launcher}`,
      `  start cmd   : ${value.startCmd}`,
      `  browser     : ${value.browser}`,
      `  port        : ${value.port}`,
      `  start line  : ${value.startCommand}`,
      `  server log  : ${value.serverLog}`,
    )
    return lines.join('\n')
  }
  if (value.action === 'remove') {
    lines.push(value.removed.length > 0 ? `  removed: ${value.removed.join(', ')}` : '  nothing to remove (already clean).')
    return lines.join('\n')
  }
  if (value.action === 'restart') {
    lines.push(
      '  Restart scheduled and verified.',
      `  helper pid    : ${value.helperPid}`,
      `  helper        : ${value.helper}`,
      `  launch script : ${value.launchScript}`,
      `  helper log    : ${value.log}`,
      `  web port      : ${value.port}`,
      `  delay         : ${value.delaySeconds}s before the current server stops`,
      `  note          : ${value.note}`,
      '',
      '  The helper waits, stops the listener, waits for the port, then relaunches',
      '  through the launcher (hidden console + app window). If the launcher cannot',
      '  bring it up it falls back to a visible console, so nothing is left broken.',
    )
    return lines.join('\n')
  }
  if (value.action === 'open') {
    lines.push(`  opened ${value.url}`, `  with   ${value.browser}`)
    return lines.join('\n')
  }
  return JSON.stringify(value, null, 2)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'desktop_app',
    description:
      'Open the DeepSeek Harness Web UI as a standalone desktop app window (Chromium --app mode: no tabs, no address bar, its own taskbar entry), ' +
      'and manage the Desktop shortcut that launches it. ' +
      "Actions: 'status' reports the detected browser and whether the shortcut is installed; 'install' writes the launcher and creates the Desktop shortcut; " +
      "'remove' deletes both; 'open' opens the app window right now; 'restart' restarts the DSH server itself (detached, so the reply is delivered first) and reopens the app window. " +
      'Windows is required for install/remove/restart.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: "One of: 'status', 'install', 'remove', 'open', 'restart'.",
      },
      browser: {
        type: 'string',
        description: "Optional. A browser id ('edge', 'chrome', 'brave', 'vivaldi', 'opera') or an absolute path to a Chromium-family executable. Defaults to the first one detected.",
      },
      icon: {
        type: 'string',
        description: 'Optional. Absolute path to a .ico file used as the shortcut icon. Defaults to the browser icon.',
      },
      shortcutName: {
        type: 'string',
        description: 'Optional. Shortcut file name on the Desktop. Defaults to "DeepSeek Harness.lnk".',
      },
      delaySeconds: {
        type: 'number',
        description: "Optional, restart only. Seconds to wait before stopping the current server, so the caller's reply reaches the user first. Defaults to 15, capped at 300.",
      },
      closeOldWindows: {
        type: 'boolean',
        description: 'Optional, restart only. After the new app window appears, close the app-mode windows that existed before the restart. Defaults to true. Only DSH app windows are closed; normal browser windows (which carry other tabs) are never touched.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
    },
    execute: async (args) => {
      const action = String(args?.action ?? '').toLowerCase()
      return runAction(action, buildContext(ctx, args))
    },
    timeoutMs: 60000,
  }))
}
