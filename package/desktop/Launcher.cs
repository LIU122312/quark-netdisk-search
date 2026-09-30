using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ZiyuanJuhe
{
    internal static class Program
    {
        internal const string APP_NAME = "资源聚合";
        private const string MUTEX_NAME = "Global\\ZiyuanJuhe_SingleInstance_v1";

        [STAThread]
        private static void Main()
        {
            bool createdNew = false;
            Mutex mtx = new Mutex(true, MUTEX_NAME, out createdNew);
            if (!createdNew)
            {
                MessageBox.Show(APP_NAME + " 已经在运行了，去任务栏找一下它的窗口。", APP_NAME,
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());
            }
            catch (Exception ex)
            {
                MessageBox.Show("启动失败：" + ex.Message, APP_NAME, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                Host.Shutdown();
                GC.KeepAlive(mtx);
            }
        }
    }

    /* ===================== 本地服务宿主 ===================== */
    internal static class Host
    {
        internal static string ExeDir;
        internal static int UiPort = 8899;
        private static Process nodeProc;
        private static Process pansouProc;
        private static IntPtr job = IntPtr.Zero;
        private static volatile bool down;

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr a, string lpName);
        [DllImport("kernel32.dll")]
        private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr info, uint len);
        [DllImport("kernel32.dll")]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr h);

        private static void InitJob()
        {
            try
            {
                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) return;
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = 0x2000;
                int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                IntPtr p = Marshal.AllocHGlobal(len);
                Marshal.StructureToPtr(info, p, false);
                SetInformationJobObject(job, 9, p, (uint)len);
                Marshal.FreeHGlobal(p);
            }
            catch (Exception) { }
        }

        private static void Adopt(Process p)
        {
            try { if (job != IntPtr.Zero && p != null) AssignProcessToJobObject(job, p.Handle); }
            catch (Exception) { }
        }

        internal static bool PortFree(int port)
        {
            TcpListener l = null;
            try
            {
                l = new TcpListener(IPAddress.Loopback, port);
                l.Start();
                return true;
            }
            catch (Exception) { return false; }
            finally { if (l != null) { try { l.Stop(); } catch (Exception) { } } }
        }

        private static int FreePort()
        {
            TcpListener l = new TcpListener(IPAddress.Loopback, 0);
            l.Start();
            int p = ((IPEndPoint)l.LocalEndpoint).Port;
            l.Stop();
            return p;
        }

        /* config.cmd 里 set 出来的频道/插件/代理，是本地服务唯一的配置真源 */
        private static Dictionary<string, string> LoadConfigEnv(string dir)
        {
            Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            string cfg = Path.Combine(dir, "config.cmd");
            if (!File.Exists(cfg)) return map;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe");
                psi.Arguments = "/c \"call config.cmd >nul 2>&1 & set\"";
                psi.WorkingDirectory = dir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                try { psi.StandardOutputEncoding = Encoding.GetEncoding(CultureInfo.CurrentCulture.TextInfo.OEMCodePage); }
                catch (Exception) { }
                using (Process p = Process.Start(psi))
                {
                    string all = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(6000);
                    string[] lines = all.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                    for (int i = 0; i < lines.Length; i++)
                    {
                        int eq = lines[i].IndexOf('=');
                        if (eq <= 0) continue;
                        string k = lines[i].Substring(0, eq);
                        string v = lines[i].Substring(eq + 1);
                        if (k.Length > 0 && v.Length > 0) map[k] = v;
                    }
                }
            }
            catch (Exception) { }
            return map;
        }

        private static void ApplyEnv(ProcessStartInfo psi, Dictionary<string, string> extra, bool setUiPort)
        {
            foreach (KeyValuePair<string, string> kv in extra)
            {
                try { psi.EnvironmentVariables[kv.Key] = kv.Value; } catch (Exception) { }
            }
            if (setUiPort) psi.EnvironmentVariables["UI_PORT"] = UiPort.ToString(CultureInfo.InvariantCulture);
        }

        private static bool TcpOpen(int port)
        {
            TcpClient c = null;
            try
            {
                c = new TcpClient();
                IAsyncResult ar = c.BeginConnect(IPAddress.Loopback, port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(400)) return false;
                c.EndConnect(ar);
                return true;
            }
            catch (Exception) { return false; }
            finally { if (c != null) { try { c.Close(); } catch (Exception) { } } }
        }

        internal static string StartAll(Action<string> status)
        {
            down = false;
            ExeDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            string node = Path.Combine(ExeDir, "runtime", "node.exe");
            string server = Path.Combine(ExeDir, "app", "ui", "server.js");
            string pansou = Path.Combine(ExeDir, "app", "pansou.exe");
            string logs = Path.Combine(ExeDir, "logs");
            try { Directory.CreateDirectory(logs); } catch (Exception) { }
            if (!File.Exists(node)) return "缺少 runtime\\node.exe，压缩包不完整。";
            if (!File.Exists(server)) return "缺少 app\\ui\\server.js，压缩包不完整。";
            InitJob();

            Dictionary<string, string> env = LoadConfigEnv(ExeDir);
            status("正在准备检索服务...");

            if (File.Exists(pansou) && !TcpOpen(8888))
            {
                try
                {
                    ProcessStartInfo pi = new ProcessStartInfo(pansou);
                    pi.WorkingDirectory = Path.Combine(ExeDir, "app");
                    pi.UseShellExecute = false;
                    pi.CreateNoWindow = true;
                    pi.RedirectStandardOutput = true;
                    pi.RedirectStandardError = true;
                    ApplyEnv(pi, env, false);
                    pansouProc = Process.Start(pi);
                    Adopt(pansouProc);
                    Drain(pansouProc, Path.Combine(logs, "pansou.log"));
                }
                catch (Exception) { }
            }

            UiPort = PortFree(8899) ? 8899 : FreePort();
            try
            {
                ProcessStartInfo pi = new ProcessStartInfo(node);
                pi.Arguments = "\"" + server + "\"";
                pi.WorkingDirectory = Path.Combine(ExeDir, "app", "ui");
                pi.UseShellExecute = false;
                pi.CreateNoWindow = true;
                pi.RedirectStandardOutput = true;
                pi.RedirectStandardError = true;
                ApplyEnv(pi, env, true);
                nodeProc = Process.Start(pi);
                Adopt(nodeProc);
                Drain(nodeProc, Path.Combine(logs, "ui.log"));
            }
            catch (Exception ex) { return "界面服务启动失败：" + ex.Message; }

            string url = "http://127.0.0.1:" + UiPort + "/";
            status("正在等待本地服务就绪...");
            for (int i = 0; i < 120; i++)
            {
                if (down) return null;
                if (Ping(url)) return null;
                if (nodeProc != null && nodeProc.HasExited) return "界面服务异常退出，看 logs\\ui.log。";
                Thread.Sleep(250);
            }
            return "等本地服务超时（30 秒），看 logs\\ui.log。";
        }

        private static void Drain(Process p, string logFile)
        {
            try
            {
                StreamWriter w = new StreamWriter(new FileStream(logFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite));
                w.AutoFlush = true;
                p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) { try { w.WriteLine(e.Data); } catch (Exception) { } } };
                p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) { try { w.WriteLine(e.Data); } catch (Exception) { } } };
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
            }
            catch (Exception) { }
        }

        private static bool Ping(string url)
        {
            HttpWebRequest req = null;
            try
            {
                req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 1500;
                req.ReadWriteTimeout = 1500;
                req.Proxy = null;
                req.KeepAlive = false;
                using (HttpWebResponse r = (HttpWebResponse)req.GetResponse())
                {
                    return (int)r.StatusCode == 200;
                }
            }
            catch (Exception) { return false; }
            finally { if (req != null) { try { req.Abort(); } catch (Exception) { } } }
        }

        private static void Kill(ref Process p)
        {
            try
            {
                if (p != null && !p.HasExited)
                {
                    p.Kill();
                    p.WaitForExit(3000);
                }
            }
            catch (Exception) { }
            p = null;
        }

        internal static void Shutdown()
        {
            down = true;
            Kill(ref nodeProc);
            Kill(ref pansouProc);
            try { if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; } }
            catch (Exception) { }
        }
    }

    /* ===================== 主窗口（无边框 + 网页自带窗口按钮） ===================== */
    internal sealed class MainForm : Form
    {
        private const int WM_NCHITTEST = 0x0084;
        private const int HTCLIENT = 1, HTCAPTION = 2, HTLEFT = 10, HTRIGHT = 11, HTTOP = 12;
        private const int HTTOPLEFT = 13, HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;
        private const int RESIZE_BORDER = 0;

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        /* 原生标题栏配色：DwmSetWindowAttribute（Win11 22000+ 支持 34 边框 / 35 标题栏 / 36 文字） */
        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hWnd, int attr, ref int value, int size);

        private readonly Label statusLabel;
        private WebView2 web;
        private bool closing;
        private bool pageReady;
        private Panel fallbackBar;
        /* 内置播放器的画面承载窗口：mpv 用 --wid 直接画在这块原生子窗口上，不弹外部播放器 */
        private Panel stage;
        private string stageSpec = "";
        private bool stageShown;
        /* 进全屏播放前窗口是不是已经最大化了：退出全屏时还原回原来的样子 */
        private bool wasMaximized;

        internal MainForm()
        {
            this.Text = Program.APP_NAME;
            /* 原生标题栏：最小化 / 最大化 / 关闭 用 Windows 自己的那套（自绘那套在隐藏顶栏时还会跟着消失） */
            this.FormBorderStyle = FormBorderStyle.Sizable;
            this.MaximizeBox = true;
            this.MinimizeBox = true;
            this.Padding = new Padding(0);
            this.ClientSize = new Size(1320, 880);
            this.MinimumSize = new Size(900, 620);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(7, 7, 32);
            this.Font = new Font("Microsoft YaHei UI", 10f);
            try { this.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch (Exception) { }

            statusLabel = new Label();
            statusLabel.Dock = DockStyle.Fill;
            statusLabel.TextAlign = ContentAlignment.MiddleCenter;
            statusLabel.ForeColor = Color.FromArgb(198, 202, 218);
            statusLabel.Text = "正在启动 " + Program.APP_NAME + " ...";
            statusLabel.BackColor = Color.FromArgb(7, 7, 32);
            this.Controls.Add(statusLabel);
            this.Shown += this.OnShown;
            this.FormClosing += this.OnClosing;
        }

        private void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (!closing) { closing = true; Host.Shutdown(); }
        }

        private void Say(string s)
        {
            if (this.IsDisposed) return;
            statusLabel.Text = s;
        }

        private void SayFromBg(string s)
        {
            try
            {
                if (this.IsDisposed || !this.IsHandleCreated) return;
                this.BeginInvoke((MethodInvoker)delegate() { Say(s); });
            }
            catch (Exception) { }
        }

        private void ToggleMax()
        {
            try
            {
                if (this.WindowState == FormWindowState.Maximized) this.WindowState = FormWindowState.Normal;
                else
                {
                    Screen sc = Screen.FromControl(this);
                    this.MaximizedBounds = sc.WorkingArea;
                    this.WindowState = FormWindowState.Maximized;
                }
            }
            catch (Exception) { }
        }

        private void SetFullscreen(bool on)
        {
            try
            {
                if (on)
                {
                    if (this.WindowState == FormWindowState.Minimized) this.WindowState = FormWindowState.Normal;
                    wasMaximized = (this.WindowState == FormWindowState.Maximized);
                    if (!wasMaximized)
                    {
                        Screen sc = Screen.FromControl(this);
                        this.MaximizedBounds = sc.WorkingArea;
                        this.WindowState = FormWindowState.Maximized;
                    }
                }
                else if (!wasMaximized && this.WindowState == FormWindowState.Maximized)
                {
                    this.WindowState = FormWindowState.Normal;
                }
            }
            catch (Exception) { }
        }

        private void SetChromeColor(string hex)
        {
            try
            {
                hex = hex.Trim();
                if (hex.Length != 7 || hex[0] != '#') return;
                Color c = ColorTranslator.FromHtml(hex);
                this.BackColor = c;
                if (statusLabel != null) statusLabel.BackColor = c;
                if (fallbackBar != null) fallbackBar.BackColor = c;
            }
            catch (Exception) { }
        }

        /* spec = "标题栏色,文字色,用深色(0/1),边框色"（页面按当前主题算好发过来，标题栏/边框跟页面同一套颜色） */
        private void ApplyChrome(string spec)
        {
            try
            {
                string[] p = spec.Split(',');
                if (p.Length < 2) return;
                Color cap = ColorTranslator.FromHtml(p[0].Trim());
                Color txt = ColorTranslator.FromHtml(p[1].Trim());
                bool dark = (p.Length < 3) ? true : (p[2].Trim() == "1");
                Color bd = cap;
                if (p.Length >= 4 && p[3].Trim().Length == 7) bd = ColorTranslator.FromHtml(p[3].Trim());
                this.BackColor = cap;
                if (statusLabel != null) statusLabel.BackColor = cap;
                if (fallbackBar != null) fallbackBar.BackColor = cap;
                if (!this.IsHandleCreated) return;
                int v = dark ? 1 : 0;
                DwmSetWindowAttribute(this.Handle, 20, ref v, 4);
                v = cap.R | (cap.G << 8) | (cap.B << 16);
                DwmSetWindowAttribute(this.Handle, 35, ref v, 4);
                v = txt.R | (txt.G << 8) | (txt.B << 16);
                DwmSetWindowAttribute(this.Handle, 36, ref v, 4);
                v = bd.R | (bd.G << 8) | (bd.B << 16);
                DwmSetWindowAttribute(this.Handle, 34, ref v, 4);
            }
            catch (Exception) { }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            /* 页面还没报主题过来时的兜底：跟深色侧栏同色，免得开机先闪一条白标题栏 */
            ApplyChrome("#070720,#ffffff,1,#070720");
        }

        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string msg = null;
            try { msg = e.TryGetWebMessageAsString(); }
            catch (Exception) { }
            if (msg == null) return;
            if (msg == "hello") { pageReady = true; if (fallbackBar != null) fallbackBar.Visible = false; return; }
            if (msg == "drag")
            {
                ReleaseCapture();
                SendMessage(this.Handle, 0x00A1, (IntPtr)HTCAPTION, IntPtr.Zero);
                return;
            }
            if (msg == "min") { this.WindowState = FormWindowState.Minimized; return; }
            if (msg == "max") { ToggleMax(); return; }
            if (msg == "close") { this.Close(); return; }
            if (msg.StartsWith("bg:")) { SetChromeColor(msg.Substring(3)); return; }
            if (msg.StartsWith("chrome:")) { ApplyChrome(msg.Substring(7)); return; }
            if (msg.StartsWith("video:")) { ShowStage(msg.Substring(6)); return; }
            if (msg == "videohide") { HideStage(); return; }
            if (msg.StartsWith("videofull"))
            {
                /* 全屏播放 = 窗口最大化；页面那边同时会把外围 UI 收起来，画面铺满整块客户区。
                   videofull:1 进全屏 / videofull:0 退出（还原进全屏之前的窗口状态） */
                string arg = msg.Length > 9 ? msg.Substring(9).TrimStart(':') : "";
                if (arg == "1") SetFullscreen(true);
                else if (arg == "0") SetFullscreen(false);
                else ToggleMax();
                return;
            }
        }

        /* ===================== 内置播放器画面 ===================== */
        private void EnsureStage()
        {
            if (stage != null) return;
            stage = new Panel();
            stage.BackColor = Color.Black;
            stage.Visible = false;
            this.Controls.Add(stage);
        }

        /* spec = "左,上,宽,高,缩放"（页面按 CSS 像素给，缩放给 devicePixelRatio，DPI 不是 100% 时才对得上） */
        private void ShowStage(string spec)
        {
            string[] p = spec.Split(',');
            if (p.Length < 4) return;
            double x, y, w, h, dpr = 1;
            if (!double.TryParse(p[0], NumberStyles.Float, CultureInfo.InvariantCulture, out x)) return;
            if (!double.TryParse(p[1], NumberStyles.Float, CultureInfo.InvariantCulture, out y)) return;
            if (!double.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out w)) return;
            if (!double.TryParse(p[3], NumberStyles.Float, CultureInfo.InvariantCulture, out h)) return;
            if (p.Length >= 5) double.TryParse(p[4], NumberStyles.Float, CultureInfo.InvariantCulture, out dpr);
            if (dpr < 0.2 || dpr > 8) dpr = 1;
            if (w < 40 || h < 40) return;
            EnsureStage();
            int lw = Math.Max(8, this.ClientSize.Width);
            int lh = Math.Max(8, this.ClientSize.Height);
            int cx = (int)Math.Round(x * dpr), cy = (int)Math.Round(y * dpr);
            int cw = (int)Math.Round(w * dpr), ch = (int)Math.Round(h * dpr);
            /* 页面往上滚时画面要跟着滚出视野：坐标允许为负，超出客户区的那部分系统会自己裁掉 */
            if (cw > lw) cw = lw;
            if (ch > lh) ch = lh;
            if (cw < 40) cw = 40;
            if (ch < 40) ch = 40;
            stage.Bounds = new Rectangle(cx, cy, cw, ch);
            stageSpec = spec;
            if (this.WindowState == FormWindowState.Minimized) return;
            if (!stage.Visible) stage.Visible = true;
            stage.BringToFront();
            if (fallbackBar != null && fallbackBar.Visible) fallbackBar.BringToFront();
            stageShown = true;
            PostHwnd();
        }

        private void HideStage()
        {
            stageShown = false;
            if (stage != null && stage.Visible) stage.Visible = false;
            if (web != null) { try { web.BringToFront(); } catch (Exception) { } }
        }

        private void PostHwnd()
        {
            if (stage == null || web == null || web.CoreWebView2 == null) return;
            try
            {
                web.CoreWebView2.PostWebMessageAsJson(
                    "{\"t\":\"hwnd\",\"v\":" + stage.Handle.ToInt64().ToString(CultureInfo.InvariantCulture) + "}");
            }
            catch (Exception) { }
        }

        private async void OnShown(object sender, EventArgs e)
        {
            string err = null;
            await Task.Run(delegate() { err = Host.StartAll(delegate(string s) { SayFromBg(s); }); });
            if (closing) return;
            if (err != null)
            {
                Say(err);
                MessageBox.Show(err, this.Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            Say("正在初始化窗口内核...");
            try
            {
                string ud = Path.Combine(Host.ExeDir, "data", "webview2");
                try { Directory.CreateDirectory(ud); }
                catch (Exception)
                {
                    ud = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "资源聚合", "WebView2");
                }
                CoreWebView2EnvironmentOptions opt = null;
                string dbg = Environment.GetEnvironmentVariable("ZYJH_DEBUG_PORT");
                if (!string.IsNullOrEmpty(dbg))
                {
                    opt = new CoreWebView2EnvironmentOptions();
                    opt.AdditionalBrowserArguments = "--remote-debugging-port=" + dbg;
                }
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, ud, opt);
                web = new WebView2();
                web.Dock = DockStyle.Fill;
                this.Controls.Add(web);
                web.BringToFront();
                await web.EnsureCoreWebView2Async(env);
                if (web.CoreWebView2 == null) throw new InvalidOperationException("WebView2 初始化失败");
                web.CoreWebView2.Settings.AreDevToolsEnabled = false;
                web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                web.CoreWebView2.Settings.IsZoomControlEnabled = true;
                web.CoreWebView2.NewWindowRequested += this.OnNewWindow;
                web.CoreWebView2.ProcessFailed += this.OnWebFailed;
                web.CoreWebView2.WebMessageReceived += this.OnWebMessage;
                web.CoreWebView2.NavigationCompleted += delegate(object s2, CoreWebView2NavigationCompletedEventArgs e2)
                {
                    if (e2.IsSuccess) { pageReady = true; if (fallbackBar != null) fallbackBar.Visible = false; }
                };
                fallbackBar = MakeFallbackBar();
                this.Controls.Add(fallbackBar);
                PositionFallbackBar();
                fallbackBar.BringToFront();
                System.Windows.Forms.Timer ft = new System.Windows.Forms.Timer();
                ft.Interval = 6000;
                ft.Tick += delegate(object s2, EventArgs e2)
                {
                    ft.Stop();
                    if (!pageReady && fallbackBar != null) { fallbackBar.Visible = true; fallbackBar.BringToFront(); }
                };
                ft.Start();
                web.Source = new Uri("http://127.0.0.1:" + Host.UiPort + "/");
            }
            catch (Exception ex)
            {
                Say("窗口内核初始化失败：" + ex.Message);
                string msg = "打不开内置窗口，系统可能缺 WebView2 运行时。\r\n\r\n"
                    + "点「确定」用默认浏览器打开，或先装 WebView2 运行时：\r\n"
                    + "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
                if (MessageBox.Show(msg, this.Text, MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) == DialogResult.OK)
                {
                    try { Process.Start("http://127.0.0.1:" + Host.UiPort + "/"); } catch (Exception) { }
                }
            }
        }

        private void PositionFallbackBar()
        {
            if (fallbackBar == null) return;
            fallbackBar.Location = new Point(this.ClientSize.Width - fallbackBar.Width - 14, 12);
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            PositionFallbackBar();
            /* 窗口大小变了，页面会重新发一次 video:，这里兜个底，画面不跟着窗口变形 */
            if (stageShown && stageSpec.Length > 0) ShowStage(stageSpec);
        }

        private Panel MakeFallbackBar()
        {
            Panel p = new Panel();
            p.Size = new Size(122, 34);
            p.Visible = false;
            string[] labels = new string[] { "\u2212", "\u25A1", "\u2715" };
            string[] msgs = new string[] { "min", "max", "close" };
            for (int i = 0; i < 3; i++)
            {
                Button b = new Button();
                b.Text = labels[i];
                b.Tag = msgs[i];
                b.Size = new Size(36, 28);
                b.Location = new Point(4 + i * 38, 3);
                b.FlatStyle = FlatStyle.Flat;
                b.FlatAppearance.BorderSize = 0;
                b.TabStop = false;
                b.ForeColor = Color.FromArgb(85, 96, 112);
                b.BackColor = Color.Transparent;
                b.Click += delegate(object s3, EventArgs e3)
                {
                    string m = (string)((Button)s3).Tag;
                    if (m == "min") this.WindowState = FormWindowState.Minimized;
                    else if (m == "max") ToggleMax();
                    else this.Close();
                };
                p.Controls.Add(b);
            }
            return p;
        }

        private void OnWebFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            SayFromBg("窗口内核出了点问题，关掉软件重开一次即可。");
        }

        private void OnNewWindow(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            try { Process.Start(e.Uri); } catch (Exception) { }
        }
    }
}