# dsh-desktop-app

**把 DeepSeek Harness 的 Web 界面变成独立的桌面应用窗口——在 DSH 会话里直接搞定。**

[English](README.md) | 中文

这是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，注册一个宿主工具 `desktop_app`，把 Web GUI 变成一个像原生软件一样的窗口：**没有浏览器标签页、没有地址栏、没有书签栏，任务栏有独立图标**。

它复用你已有的 Chromium 内核浏览器，走 [`--app` 模式](https://developer.chrome.com/docs/apps/)——不需要 Electron，不需要额外运行时，也不需要下载任何东西。另外带一个轻量的**系统托盘宿主**：关掉窗口不再等于关掉服务，随时能从托盘叫回来。

## 为什么需要它

默认情况下 DSH 开在浏览器标签页里，和你的其他标签页混在一起。`--app` 模式给你一个专属窗口，对于一个要开一整天的东西来说，这才是顺手的形态。

## 系统托盘

浏览器窗口**无法把自己最小化到通知区域**，而关掉窗口会连进程一起带走——所以托盘驻留需要一个额外的常驻进程。生成的 launcher 会在开窗口**之前**先启动一个小的 PowerShell 宿主（`tray-host.ps1` + `tray-host.cs`，无额外运行时）。

| 你做什么 | 会发生什么 |
|---|---|
| 双击托盘图标 | 恢复窗口（已关掉则新开一个） |
| 右键 → `Minimise to tray` | 窗口隐藏，服务继续运行 |
| 右键 → `Open DeepSeek Harness` | 重新打开窗口（token 会重新读取） |
| 右键 → `Restart the local service` | 运行那个脱离式重启助手 |
| 右键 → `Quit tray host` | 退出托盘宿主（服务继续运行） |
| 点窗口的 X | 窗口关闭，**服务继续运行**，托盘弹一条说明 |

如果同时装了 [dsh-schedule-panel](https://github.com/MARIOMLY/dsh-schedule-panel)，它的面板还会提供一个**「收进托盘」按钮**：网页无法隐藏原生窗口，所以页面写一个请求文件（`tray-command.txt`），托盘宿主一秒内执行。

> 托盘图标默认用浏览器的；把 `tray.ico` 放在 `lib/desktop.js` 旁边（或给 `install` 传 `icon`）就能换成自己的。

### 做不到的两件事（以及原因）

- **X 按钮无法从外部重新定义**：跨进程子类化窗口过程（对别的进程的窗口调 `SetWindowLongPtr`）在 Windows 10/11 上返回 `ERROR_ACCESS_DENIED (5)`。已实测，代码里不再尝试。
- **`beforeunload` 确认框不会出现**：程序化打开的 `--app` 窗口里，Chromium 会静默跳过它。请改用托盘按钮或托盘图标，这两个都是确定有效的。

## 安装

```sh
# 从 GitHub 安装
dsh plugin --profile web add github:MARIOMLY/dsh-desktop-app

# 从本地目录安装
dsh plugin --profile web add /指向/dsh-desktop-app/的绝对路径
```

然后重启 `dsh web`。

确认已加载：

```sh
dsh --profile web --dump-config | grep desktop-app
```

> `github:` 方式需要能访问 `github.com`；若包带 `prepare` 构建脚本，pnpm 还会要求你放行。本插件**零构建、零运行时依赖**，所以走 npm／registry 是最顺的路径。

## 使用

在任意 DSH 会话里直接说：

> 把这个界面做成像普通软件一样独立打开。

Agent 会替你调用 `desktop_app`。也可以明确指定动作：

| 动作 | 作用 |
|---|---|
| `status` | 报告当前 Web 端口、探测到的浏览器、桌面目录、快捷方式是否已安装。出问题时先看它。 |
| `install` | 生成启动器并创建桌面快捷方式。 |
| `remove` | 删除快捷方式和启动器。 |
| `open` | 立刻打开应用窗口，不安装任何东西。 |
| `restart` | 重启 DSH 服务本身并重新打开应用窗口。采用**脱离进程 + 延时**方式，保证你的回复先送达再断服务。 |

可选参数：

| 参数 | 含义 |
|---|---|
| `browser` | 浏览器 id（`edge`、`chrome`、`brave`、`vivaldi`、`opera`）或 Chromium 内核可执行文件的绝对路径。默认取第一个探测到的。 |
| `icon` | 快捷方式图标的 `.ico` 绝对路径。默认用浏览器自带图标。 |
| `shortcutName` | 桌面上的快捷方式文件名。默认 `DeepSeek Harness.lnk`。 |
| `delaySeconds` | 仅 `restart` 用。停止服务前等待的秒数。默认 15，上限 300。 |
| `closeOldWindows` | 仅 `restart` 用。新应用窗口出现后，关闭重启前已存在的 App 模式窗口。默认 `true`。**只关 DSH 的 App 窗口**，普通浏览器窗口绝不触碰——关它会连带丢掉你其他标签页。 |

## 关于重启

`restart` 是唯一带"副作用"的动作：它必须**停掉正在运行它自己的那个服务**。它会生成一个助手脚本、**在本服务的 job object 之外**启动它，并在**确认它真的活着**之后才返回成功：

1. 助手先等待 `delaySeconds`（默认 15 秒），让你的回复先送达；
2. 停掉占用端口的进程；
3. 等待端口真正释放；
4. 通过启动器重新拉起——隐藏控制台，就绪后弹出应用窗口；
5. 关闭屏幕上所有的 App 模式 DSH 窗口（`closeOldWindows`，默认开启）——原因见下；
6. 若启动器没能把服务拉起来，**回退到可见控制台**，绝不让你落到"什么都没有"的境地。

如果你要 fork，有两点值得知道：

- **光用 `child_process.spawn` 是不够的。** DSH 用 Windows Job Object 管理子进程，spawn 出来的助手会继承 job 成员身份并被一起回收——实际表现是"进程出现后连一行都没执行就消失"，而动作当时**仍然报告成功**。所以助手改用 `Win32_Process.Create` 创建，父进程是 `WmiPrvSE.exe`，位于 job 之外。动作之后会轮询助手的首行日志，**没出现就大声报错**。
- **关旧窗口刻意安排在"新窗口创建之前"。** 服务已停，此时屏幕上每一个 DSH 窗口按定义都是死页面，而新窗口还不可能存在——所以这一步没有竞态。**更早的版本是"等新句柄出现，再关旧的"，结果不可靠**：Chromium 有时会聚焦或复用已有的 App 窗口而不新建，于是永远等不到新句柄，就什么都没关。
- **窗口筛选刻意保守。** 只有"标题包含应用标识、且不含浏览器标识"的窗口才符合条件。一个同时开着 DSH 标签页和其他标签页的浏览器窗口会被跳过——关掉它会丢掉用户的其他工作。另外标识用 `Microsoft` 而非 `Microsoft Edge`：真实的 Edge 标题里有个字符在控制台会渲染成 `?`。

日志在 `~/.dsh/desktop-app/restart.log`。

## 会创建哪些文件

```
~/.dsh/desktop-app/launch.ps1        启动器（用 install 动作可重新生成）
~/.dsh/desktop-app/start-server.cmd  记录下来的启动命令
~/.dsh/desktop-app/restart.ps1       restart 动作生成的脱离式重启助手
~/.dsh/desktop-app/tray-host.ps1     系统托盘宿主
~/.dsh/desktop-app/tray-host.cs      它的 C# 伴生文件（Win32 窗口 + NotifyIcon）
~/.dsh/desktop-app/tray-host.cmd     引号安全的宿主启动器
~/.dsh/desktop-app/tray.ico          托盘图标（可选；没有则用浏览器图标）
~/.dsh/desktop-app/tray-url.txt      带令牌的启动 URL，用于重新打开窗口
~/.dsh/desktop-app/tray-command.txt  网页写下的"隐藏窗口"请求文件
~/.dsh/desktop-app/server.log        仅当启动器需要拉起 DSH 时才有内容
~/.dsh/desktop-app/launcher.log      启动器诊断日志
~/.dsh/desktop-app/restart.log       重启助手诊断日志
~/.dsh/desktop-app/tray.log          托盘宿主诊断日志
<桌面>/DeepSeek Harness.lnk           指向启动器的快捷方式
```

`remove` 会停掉托盘宿主，并删除快捷方式、`launch.ps1`、`start-server.cmd` 与托盘相关文件；各类日志特意保留。

## 工作原理

生成的启动器刻意做得很小很简单：

1. 如果 Web 端口**已在监听** → 直接开窗口，结束。
2. 否则用 `--no-open` 启动记录下来的 DSH 命令（这样不会再多弹一个重复的浏览器标签页），等端口监听成功，然后从服务输出里读出启动时打印的**带令牌 URL**：
   ```
   dsh web: http://127.0.0.1:<端口>/?token=...
   ```
3. 用**那个** URL 以 `--app` 模式开窗。访问它会种下签名认证 Cookie，所以即使浏览器还没有 Cookie 也能进——这正是看到莫名其妙的 `401 authentication required` 页面的常见原因。

启动命令是在安装时从活着的 DSH 进程里抓取的（`process.execPath` + `process.argv[1]`），所以如果你移动了 DSH 位置、或从 `npx` 换成了全局安装，重新跑一次 `install` 即可。

## 要求与注意事项

- `install` / `remove` **仅支持 Windows**（它们通过 `WScript.Shell` 创建 `.lnk`）。`status` 和 `open` 在 macOS 和 Linux 上同样可用。
- 需要装有 Chromium 内核浏览器。Windows 自带 Edge，通常已满足。
- 本插件是驱动已有的浏览器，**不是**官方 Electron 桌面端——DSH 为后者保留了 `desktop` profile，属于另外单独分发的产物。
- 生成的启动器**刻意只用 ASCII**。Windows PowerShell 5.1 在文件没有 UTF-8 BOM 时按 ANSI 代码页读取 `.ps1`，中文注释可能破坏解析。如果你要 fork，请保持纯 ASCII。
- 服务是从一个生成的 **`.cmd` 文件**启动的，而不是 `cmd /c "<带空格的引号路径>" ... > 日志`。当 `/c` 后的第一个字符是引号时，cmd.exe 的引号剥除规则会让整条命令（**包括重定向**）解析失败，而且是**静默失败**——不产生输出文件、不弹窗口、什么都没有。
- 创建 `.lnk` 的临时脚本会**带 UTF-8 BOM 写入**，因为它内嵌用户提供的路径。没有 BOM 时，像 `…\图片\app.ico` 这样的非 ASCII 图标路径会被按 ANSI 解码而损坏，快捷方式只能退回默认图标。

## 给 fork 者的实现备忘

开发过程中踩到的两个坑都以注释形式留在 `lib/desktop.js` 里，因为两者都很容易被重新引入：

1. **`cmd /c` 的引号剥除。** 「点了图标没反应、且没有日志文件」正是重定向失败的典型特征，而不是"文件不存在"。
2. **无 BOM 的 `.ps1` 内嵌用户路径。** 任何生成物只要含路径，就必须带 BOM 写入，否则路径会被静默损坏。

## 验证

`status` 是推荐的入手点。一次健康的安装长这样：

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

## 卸载

```sh
dsh plugin --profile web remove dsh-desktop-app
```

然后删除桌面上的快捷方式（或先跑一次 `remove` 动作）。

## 许可

MIT © MARIOMLY
