# dsh-desktop-app

**Open the DeepSeek Harness Web UI as a standalone desktop app window — from inside a DSH session.**

[中文说明](README.zh.md) | English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that registers one host tool, `desktop_app`. It turns the Web GUI into a window that looks and behaves like native software: **no browser tabs, no address bar, no bookmark bar, its own taskbar entry and icon**.

It uses your existing Chromium-family browser in [`--app` mode](https://developer.chrome.com/docs/apps/) — no Electron, no extra runtime, nothing to download.

## Why

By default DSH opens in a browser tab, mixed in with your other tabs. `--app` mode gives you a dedicated window instead, which is what you actually want for something you keep open all day.

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

Optional parameters:

| Parameter | Meaning |
|---|---|
| `browser` | A browser id (`edge`, `chrome`, `brave`, `vivaldi`, `opera`) or an absolute path to a Chromium-family executable. Defaults to the first one detected. |
| `icon` | Absolute path to a `.ico` file for the shortcut. Defaults to the browser's own icon. |
| `shortcutName` | Shortcut file name on the Desktop. Defaults to `DeepSeek Harness.lnk`. |

## What gets created

```
~/.dsh/desktop-app/launch.ps1     the launcher (regenerate with `install`)
~/.dsh/desktop-app/server.log     server output, only when the launcher had to start DSH
<Desktop>/DeepSeek Harness.lnk    the shortcut, pointing at the launcher
```

`remove` deletes the shortcut and `launch.ps1`; `server.log` is left behind on purpose.

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
