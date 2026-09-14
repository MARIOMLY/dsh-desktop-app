# dsh-desktop-app

**Open the DeepSeek Harness Web UI as a standalone desktop app window — from inside a DSH session.**

[中文说明](README.zh.md) | English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that registers one host tool, `desktop_app`. It turns the Web GUI into a window that looks and behaves like native software: **no browser tabs, no address bar, no bookmark bar, its own taskbar entry and icon**.

It uses your existing Chromium-family browser in [`--app` mode](https://developer.chrome.com/docs/apps/) — no Electron, no extra runtime, nothing to download. A small **notification-area host** keeps the app reachable after the window is closed, so closing the window no longer means stopping the service.

## Why

By default DSH opens in a browser tab, mixed in with your other tabs. `--app` mode gives you a dedicated window instead, which is what you actually want for something you keep open all day.

## System tray

A browser window cannot minimise itself to the notification area, and closing it takes its process with it — so tray residency needs a separate long-lived process. The generated launcher starts one small PowerShell host (`tray-host.ps1` + `tray-host.cs`, no extra runtime) before opening the window.

| What you do | What happens |
|---|---|
| Double-click the tray icon | Window restored (or opened, if you closed it) |
| Right-click → `Minimise to tray` | Window hidden; the service keeps running |
| Right-click → `Open DeepSeek Harness` | Opens the window again with a freshly read token |
| Right-click → `Restart the local service` | Runs the detached restart helper |
| Right-click → `Quit tray host` | Stops the tray host (the service keeps running) |
| Close the window with X | Window closes, the service **keeps running**, and the tray host says so once |

If the [dsh-schedule-panel](https://github.com/MARIOMLY/dsh-schedule-panel) plugin is installed, its panel also offers a **“收进托盘” (minimise to tray)** button: the page cannot hide a native window, so it drops a request file (`tray-command.txt`) that the tray host picks up within a second.

> The icon defaults to the browser's own; drop a `tray.ico` next to `lib/desktop.js` (or point `install` at one with `icon`) to brand it.

### What can't be done, and why

- **The X button cannot be redefined from outside.** Subclassing the window procedure across processes (`SetWindowLongPtr` on another process's window) returns `ERROR_ACCESS_DENIED (5)` on Windows 10/11. Verified; the code does not attempt it.
- **`beforeunload` confirmations do not appear** in a programmatically opened `--app` window — Chromium suppresses them. Use the tray button or the tray icon instead; both are deterministic.

## Install

```sh
# from GitHub
dsh plugin --profile web add github:MARIOMLY/dsh-desktop-app

# from a local checkout
dsh plugin --profile web add /absolute/path/to/dsh-desktop-app
```

Then restart `dsh web`.

Verify it loaded:

```sh
dsh --profile web --dump-config | grep desktop-app
```

> `github:` installs need `github.com` to be reachable, and pnpm will ask you to allow the `prepare` build script if the package has one. This plugin has **no build step and no runtime dependencies**, so `npm`/registry installs are the smoothest path.

## Usage

Just ask, in any DSH session:

> Make this open like a normal desktop app.

The agent calls `desktop_app` for you. Or be explicit about the action:

| Action | What it does |
|---|---|
| `status` | Reports the live web port, the detected browser, the Desktop directory, and whether the shortcut is installed. Start here if something looks wrong. |
| `install` | Writes the launcher and creates the Desktop shortcut. |
| `remove` | Deletes the shortcut and the launcher. |
| `open` | Opens the app window right now, without installing anything. |
| `restart` | Restarts the DSH server itself and reopens the app window. Detached and delayed, so your reply is delivered before the server goes down. |

Optional parameters:

| Parameter | Meaning |
|---|---|
| `browser` | A browser id (`edge`, `chrome`, `brave`, `vivaldi`, `opera`) or an absolute path to a Chromium-family executable. Defaults to the first one detected. |
| `icon` | Absolute path to a `.ico` file for the shortcut. Defaults to the browser's own icon. |
| `shortcutName` | Shortcut file name on the Desktop. Defaults to `DeepSeek Harness.lnk`. |
| `delaySeconds` | `restart` only. Seconds to wait before stopping the server. Defaults to 15, capped at 300. |
| `closeOldWindows` | `restart` only. Once the new app window has appeared, close the app-mode windows that existed before the restart. Defaults to `true`. Only DSH app windows are closed — a normal browser window is never touched, because closing it would take your other tabs with it. |

## Restarting

`restart` is the one action with a twist: it has to stop the server that is running it. It writes a helper, starts it **outside this server's job object**, and verifies it is actually alive before reporting success.

1. the helper waits `delaySeconds` (15 by default) so the reply reaches you first;
2. it stops whatever holds the port;
3. it waits for the port to be released;
4. it relaunches through the launcher — hidden console, app window when ready;
5. it closes the app-mode windows that were on screen (`closeOldWindows`, on by default) — see below;
6. if the launcher cannot bring the server up, it falls back to a **visible console** so you are never left with nothing.

Three things worth knowing if you fork this:

- **A plain `child_process.spawn` is not enough.** DSH manages its children through a Windows job object, so a spawned helper inherits job membership and is torn down with it — observed in practice as a process that appears and then exits before executing a single line, while the action still reported success. The helper is therefore created with `Win32_Process.Create`, which parents it to `WmiPrvSE.exe`, outside the job. The action then polls for the helper's first log line and **fails loudly** if it never shows up.
- **Old windows are closed *before* the replacement is created, on purpose.** With the server stopped, every DSH window on screen is dead by definition and the new one cannot exist yet, so the step is race-free. An earlier version waited for a "new" window handle to appear and only then closed the old ones — that proved unreliable, because Chromium sometimes focuses or reuses the existing app window instead of creating a new one, so no new handle ever appeared and nothing was closed.
- **The window filter is deliberately conservative.** Only titles containing the app marker and no browser-name marker qualify. A browser window holding the DSH tab *plus other tabs* is skipped, because closing it would lose the user's other work. Note the marker uses `Microsoft` rather than `Microsoft Edge`: the real Edge title contains a character that renders as `?` in consoles.

The helper log is at `~/.dsh/desktop-app/restart.log`.

## What gets created

```
~/.dsh/desktop-app/launch.ps1     the launcher (regenerate with `install`)
~/.dsh/desktop-app/start-server.cmd  the recorded start command
~/.dsh/desktop-app/restart.ps1    the detached restart helper, written by `restart`
~/.dsh/desktop-app/tray-host.ps1  the notification-area host
~/.dsh/desktop-app/tray-host.cs   its C# companion (Win32 window + NotifyIcon)
~/.dsh/desktop-app/tray-host.cmd  quoting-safe launcher for the host
~/.dsh/desktop-app/tray.ico       the tray icon (optional; browser icon otherwise)
~/.dsh/desktop-app/tray-url.txt   the tokenised boot URL, for reopening the window
~/.dsh/desktop-app/tray-command.txt  request file the web page writes to hide the window
~/.dsh/desktop-app/server.log     server output, only when the launcher had to start DSH
~/.dsh/desktop-app/launcher.log   launcher diagnostics
~/.dsh/desktop-app/restart.log    restart helper diagnostics
~/.dsh/desktop-app/tray.log       tray host diagnostics
<Desktop>/DeepSeek Harness.lnk    the shortcut, pointing at the launcher
```

`remove` stops the tray host and deletes the shortcut, `launch.ps1`, `start-server.cmd` and the tray files; the logs are left behind on purpose.

## How it works

The generated launcher is deliberately small and boring:

1. If the web port is **already listening** → open the app window. Done.
2. Otherwise start the recorded DSH command with `--no-open` (so you don't also get a duplicate browser tab), wait for the listener, then read the **tokenised URL** the server prints at boot:
   ```
   dsh web: http://127.0.0.1:<port>/?token=...
   ```
3. Open *that* URL in `--app` mode. Visiting it mints the signed auth cookie, so the window works even when the browser has no cookie yet — the usual cause of a mysterious `401 authentication required` page.

The start command is captured from the live DSH process (`process.execPath` + `process.argv[1]`) at install time, so re-run `install` if you move DSH or switch from `npx` to a global install.

## Requirements and caveats

- **Windows** is required for `install` / `remove` (they create a `.lnk` through `WScript.Shell`). `status` and `open` work on macOS and Linux too.
- A Chromium-family browser must be installed. Edge ships with Windows, so this is normally satisfied.
- This plugin drives an existing browser. It is **not** the official Electron desktop app — DSH reserves a `desktop` profile for that, and it is distributed separately.
- The generated launcher is written **ASCII-only on purpose**. Windows PowerShell 5.1 reads `.ps1` files using the ANSI code page unless the file carries a UTF-8 BOM, so non-ASCII comments can corrupt parsing. If you fork this, keep it plain ASCII.
- The server is started from a generated **`.cmd` file** rather than `cmd /c "<quoted path>" ... > log`. When the first character after `/c` is a quote, cmd.exe's quote-stripping rules make the whole command — redirect included — mis-parse, and it fails *silently*: no output file, no console, nothing.
- The temporary script that creates the `.lnk` is written **with a UTF-8 BOM**, because it embeds user-supplied paths. Without the BOM a non-ASCII icon path is decoded as ANSI and comes back corrupted, leaving the shortcut with a default icon.

## Implementation notes for forkers

Two bugs found while building this are preserved as comments in `lib/desktop.js`, because both are easy to reintroduce:

1. **`cmd /c` quote-stripping.** A launcher that "does nothing when clicked", with no log file written, is the signature of a failed redirect — not a missing file.
2. **BOM-less `.ps1` carrying a user path.** Anything generated that embeds a path must be written with a BOM, or the path is silently mangled.

## Verify

`status` is the intended entry point. A healthy install looks like this:

```
desktop_app -> status
  platform        : win32
  web port        : 3080
  base URL        : http://127.0.0.1:3080/
  browser         : Microsoft Edge (C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe)
  desktop dir     : C:\Users\you\Desktop
  shortcut        : C:\Users\you\Desktop\DeepSeek Harness.lnk [installed]
  launcher        : C:\Users\you\.dsh\desktop-app\launch.ps1 [present]
```

## Uninstall

```sh
dsh plugin --profile web remove dsh-desktop-app
```

and delete the shortcut from your Desktop (or run the `remove` action first).

## License

MIT © MARIOMLY
