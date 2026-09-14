using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

// Tray host for the DeepSeek Harness desktop app.
//
// Why this type exists: the "desktop app" is Microsoft Edge in --app mode, i.e. a
// browser window. A browser page cannot minimise itself to the notification area and
// a closed window takes its process with it, so tray residency needs a long-lived
// host -- this class, driven by tray-host.ps1.
public class DshTrayHost
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);

    // NOTE: intercepting the window's WM_CLOSE by subclassing it from this process
    // does NOT work -- SetWindowLongPtr on another process's window returns
    // ERROR_ACCESS_DENIED (5) on Windows 10/11, which forbids cross-process
    // subclassing. Verified here. So the X button cannot be redefined from outside;
    // the panel instead offers an explicit "minimise to tray" button (see
    // ProcessCommand) and the tray icon itself is the durable safety net.

    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    const int SW_HIDE = 0;
    const int SW_RESTORE = 9;

    readonly string stateDir;
    readonly string browser;
    readonly string title;
    readonly string urlFile;
    readonly string logFile;
    readonly string iconFile;
    readonly string commandFile;

    NotifyIcon icon;
    Timer watch;
    IntPtr window = IntPtr.Zero;
    /** Set once we have told the user the window went away but the service did not. */
    bool toldAboutClose;

    public DshTrayHost(string stateDir, string browser, string title)
        : this(stateDir, browser, title, null)
    {
    }

    /// <param name="iconFile">Optional .ico for the notification-area icon; when it is
    /// missing or unreadable the browser's own icon is used instead.</param>
    public DshTrayHost(string stateDir, string browser, string title, string iconFile)
    {
        this.stateDir = stateDir;
        this.browser = browser;
        this.title = title;
        this.iconFile = iconFile;
        this.urlFile = Path.Combine(stateDir, "tray-url.txt");
        this.logFile = Path.Combine(stateDir, "tray.log");
        // The web page cannot hide a native window, so it asks the tray host to do it
        // through this file (the panel's "minimise to tray" button).
        this.commandFile = Path.Combine(stateDir, "tray-command.txt");
    }

    void Log(string message)
    {
        try
        {
            File.AppendAllText(logFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine);
        }
        catch { }
    }

    public void Start()
    {
        window = Find();
        if (window == IntPtr.Zero) OpenWindow();

        icon = new NotifyIcon();
        icon.Icon = PickIcon();
        icon.Text = "DeepSeek Harness";
        icon.Visible = true;
        icon.DoubleClick += delegate { Show(); };

        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add("Open DeepSeek Harness", null, delegate { Show(); });
        menu.Items.Add("Minimise to tray", null, delegate { Hide(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Restart the local service", null, delegate { Restart(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit tray host", null, delegate { ExitHost(); });
        icon.ContextMenuStrip = menu;

        watch = new Timer();
        watch.Interval = 2000;
        watch.Tick += delegate { Refresh(); };
        watch.Start();

        Log("tray host started (window=" + window.ToString() + ")");
    }

    void Notify(string title, string body)
    {
        try
        {
            if (icon == null) return;
            icon.BalloonTipTitle = title;
            icon.BalloonTipText = body;
            icon.BalloonTipIcon = ToolTipIcon.Info;
            icon.ShowBalloonTip(6000);
        }
        catch (Exception error)
        {
            Log("notify failed: " + error.Message);
        }
    }

    Icon PickIcon()
    {
        // Prefer the user-supplied icon so the tray entry matches the app's brand.
        if (iconFile != null && File.Exists(iconFile))
        {
            try
            {
                // Copy through a MemoryStream: Icon keeps the file handle open otherwise,
                // which would lock the .ico against replacement on the next install.
                byte[] raw = File.ReadAllBytes(iconFile);
                using (MemoryStream stream = new MemoryStream(raw))
                {
                    return new Icon(stream, new Size(16, 16));
                }
            }
            catch (Exception error)
            {
                Log("icon file unusable, falling back to the browser icon: " + error.Message);
            }
        }
        // Fallback: reuse the browser's own icon (no asset needed, always available).
        try
        {
            Icon extracted = Icon.ExtractAssociatedIcon(browser);
            if (extracted != null) return extracted;
        }
        catch { }
        return SystemIcons.Application;
    }

    string ReadUrl()
    {
        try
        {
            if (!File.Exists(urlFile)) return null;
            string text = File.ReadAllText(urlFile).Trim();
            return text.Length == 0 ? null : text;
        }
        catch { return null; }
    }

    IntPtr Find()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            int length = GetWindowTextLengthW(h);
            if (length <= 0) return true;
            StringBuilder sb = new StringBuilder(length + 2);
            GetWindowTextW(h, sb, sb.Capacity);
            string text = sb.ToString();
            if (text.IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                found = h;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public void Show()
    {
        window = Find();
        if (window == IntPtr.Zero) { OpenWindow(); return; }
        ShowWindow(window, SW_RESTORE);
        SetForegroundWindow(window);
        Log("window restored");
    }

    public void Hide()
    {
        window = Find();
        if (window == IntPtr.Zero) { Log("hide: window not found"); return; }
        ShowWindow(window, SW_HIDE);
        Log("window hidden to tray");
    }

    public void OpenWindow()
    {
        string url = ReadUrl();
        if (url == null)
        {
            Log("open: no url recorded yet");
            return;
        }
        try
        {
            ProcessStartInfo info = new ProcessStartInfo(browser, "--app=" + url);
            info.UseShellExecute = true;
            Process.Start(info);
            Log("window opened");
            window = IntPtr.Zero;
        }
        catch (Exception error)
        {
            Log("open failed: " + error.Message);
        }
    }

    void Restart()
    {
        string script = Path.Combine(stateDir, "restart.ps1");
        if (!File.Exists(script)) { Log("restart: helper missing"); return; }
        try
        {
            ProcessStartInfo info = new ProcessStartInfo("powershell.exe",
                "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            Process.Start(info);
            Log("restart helper launched");
        }
        catch (Exception error)
        {
            Log("restart failed: " + error.Message);
        }
    }

    void Refresh()
    {
        ProcessCommand();

        // If the app window went away (the user closed it with X, which we cannot
        // intercept), say so once: without a word the interface just vanishes and it
        // looks like the app died, when in fact the service is still running.
        if (window != IntPtr.Zero)
        {
            StringBuilder sb = new StringBuilder(512);
            GetWindowTextW(window, sb, sb.Capacity);
            if (sb.ToString().Length == 0)
            {
                window = IntPtr.Zero;
                if (!toldAboutClose)
                {
                    toldAboutClose = true;
                    Notify("DeepSeek Harness is still running",
                        "The window was closed; the service keeps running in the background. Double-click this tray icon to open it again.");
                    Log("window closed by the user; service still running");
                }
            }
        }
        if (window == IntPtr.Zero)
        {
            IntPtr found = Find();
            if (found != IntPtr.Zero)
            {
                window = found;
                toldAboutClose = false;
                Log("attached to window " + found.ToString());
            }
        }
    }

    /// <summary>
    /// Run a request written by the web page. The page cannot hide or minimise a
    /// native window, so the panel's "minimise to tray" button drops a command file
    /// and this side performs it. The file is deleted first so a request is handled
    /// exactly once (and a stale one is never replayed at the next start).
    /// </summary>
    void ProcessCommand()
    {
        if (!File.Exists(commandFile)) return;
        string command = "";
        try
        {
            command = File.ReadAllText(commandFile).Trim().ToLowerInvariant();
        }
        catch (Exception error)
        {
            Log("command unreadable: " + error.Message);
        }
        try { File.Delete(commandFile); } catch { }

        if (command.Length == 0) return;
        Log("command received: " + command);
        if (command == "hide" || command == "minimise" || command == "minimize")
        {
            Hide();
        }
        else if (command == "open" || command == "show")
        {
            Show();
        }
    }

    public void ExitHost()
    {
        Log("exit requested");
        if (watch != null) watch.Stop();
        if (icon != null) { icon.Visible = false; icon.Dispose(); }
        Application.Exit();
    }
}
