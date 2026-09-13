# dsh-desktop-app

**把 DeepSeek Harness 的 Web 界面变成独立的桌面应用窗口——在 DSH 会话里直接搞定。**

[English](README.md) | 中文

这是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，注册一个宿主工具 `desktop_app`，把 Web GUI 变成一个像原生软件一样的窗口：**没有浏览器标签页、没有地址栏、没有书签栏，任务栏有独立图标**。

它复用你已有的 Chromium 内核浏览器，走 [`--app` 模式](https://developer.chrome.com/docs/apps/)——不需要 Electron，不需要额外运行时，也不需要下载任何东西。

## 为什么需要它

默认情况下 DSH 开在浏览器标签页里，和你的其他标签页混在一起。`--app` 模式给你一个专属窗口，对于一个要开一整天的东西来说，这才是顺手的形态。

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

可选参数：

| 参数 | 含义 |
|---|---|
| `browser` | 浏览器 id（`edge`、`chrome`、`brave`、`vivaldi`、`opera`）或 Chromium 内核可执行文件的绝对路径。默认取第一个探测到的。 |
| `icon` | 快捷方式图标的 `.ico` 绝对路径。默认用浏览器自带图标。 |
| `shortcutName` | 桌面上的快捷方式文件名。默认 `DeepSeek Harness.lnk`。 |

## 会创建哪些文件

```
~/.dsh/desktop-app/launch.ps1     启动器（用 install 动作可重新生成）
~/.dsh/desktop-app/server.log     仅当启动器需要拉起 DSH 时才有内容
<桌面>/DeepSeek Harness.lnk        指向启动器的快捷方式
```

`remove` 会删除快捷方式和 `launch.ps1`；`server.log` 特意保留。

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
