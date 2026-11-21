using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Forms;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace AgyBackdropCompanion
{
    internal sealed class ThemeConfig
    {
        public bool backdropEnabled = true;
        public bool hudEnabled = true;
        public string hostThemeMode = "backdrop";
        public int hostBlendPct = 25;
        public string activeWallpaperId = "wp-1";
        public int opacity = 100;
        public int blur = 0;
        public int dim = 0;
        public int radius = 10;
        public string fit = "cover";
        public string canvasColor = "#14161D";
        public string accentColor = "#5B8CFF";
        public string wallpaperPath = "";
    }

    internal sealed class HudTelemetry
    {
        public int percent = 0;
        public long totalUsed = 0;
        public long windowCap = 512000;
        public double? tokPerSec = null;
        public string upstreamModelId = "";
        public string upstreamModelStatus = "no_baseline";
        public bool cdpHudActive = false;
    }

    internal struct HudAnchorInfo
    {
        public bool HasAnchor;
        public bool ComposerVisible;
        public bool Occluded;
        public bool FromUia;
        public int RightX;
        public int LeftGuardX;
        public int CenterY;
        public int AnchorWinLeft;
        public int AnchorWinTop;
        public int AnchorWinRight;
        public int AnchorWinBottom;
    }

    internal struct ActiveViewInfo
    {
        public string Workspace;
        public string Title;
    }

    internal static class Native
    {
        public const int GWLP_HWNDPARENT = -8;
        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_TRANSPARENT = 0x00000020;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const int WS_EX_LAYERED = 0x00080000;
        public const int WS_EX_NOACTIVATE = 0x08000000;

        public const uint LWA_ALPHA = 0x00000002;

        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOZORDER = 0x0004;
        public const uint SWP_NOACTIVATE = 0x0010;
        public const uint SWP_SHOWWINDOW = 0x0040;
        public const uint SWP_HIDEWINDOW = 0x0080;

        public const int SW_HIDE = 0;
        public const int SW_SHOWNOACTIVATE = 4;

        public const uint GW_HWNDNEXT = 2;
        public const uint GW_HWNDPREV = 3;
        public const uint GW_OWNER = 4;

        public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        public const int DWMWA_CLOAKED = 14;

        public const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
        public const uint EVENT_SYSTEM_MOVESIZESTART = 0x000A;
        public const uint EVENT_SYSTEM_MOVESIZEEND = 0x000B;
        public const uint EVENT_SYSTEM_MINIMIZESTART = 0x0016;
        public const uint EVENT_SYSTEM_MINIMIZEEND = 0x0017;
        public const uint EVENT_OBJECT_DESTROY = 0x8001;
        public const uint EVENT_OBJECT_SHOW = 0x8002;
        public const uint EVENT_OBJECT_HIDE = 0x8003;
        public const uint EVENT_OBJECT_FOCUS = 0x8005;
        public const uint EVENT_OBJECT_SELECTION = 0x8006;
        public const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
        public const uint WINEVENT_OUTOFCONTEXT = 0x0000;

        public const uint RDW_INVALIDATE = 0x0001;
        public const uint RDW_FRAME = 0x0400;
        public const uint RDW_UPDATENOW = 0x0100;

        public const uint INPUT_MOUSE = 0;
        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
        public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

        public const int SM_XVIRTUALSCREEN = 76;
        public const int SM_YVIRTUALSCREEN = 77;
        public const int SM_CXVIRTUALSCREEN = 78;
        public const int SM_CYVIRTUALSCREEN = 79;
        public const int VK_LBUTTON = 0x01;

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Explicit)]
        public struct INPUTUNION
        {
            [FieldOffset(0)]
            public MOUSEINPUT mi;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT
        {
            public uint type;
            public INPUTUNION U;
        }

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        public delegate void WinEventDelegate(
            IntPtr hWinEventHook,
            uint eventType,
            IntPtr hwnd,
            int idObject,
            int idChild,
            uint dwEventThread,
            uint dwmsEventTime
        );

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsZoomed(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern int SHParseDisplayName(
            [MarshalAs(UnmanagedType.LPWStr)] string name,
            IntPtr bindingContext,
            out IntPtr pidl,
            uint sfgaoIn,
            out uint psfgaoOut
        );

        [DllImport("shell32.dll")]
        public static extern int SHOpenFolderAndSelectItems(
            IntPtr pidlFolder,
            uint cidl,
            IntPtr apidl,
            uint dwFlags
        );

        [DllImport("ole32.dll")]
        public static extern void CoTaskMemFree(IntPtr pv);

        public static void ForceActivateWindow(IntPtr targetHwnd)
        {
            if (targetHwnd == IntPtr.Zero || !IsWindow(targetHwnd)) return;
            uint fgTid = 0;
            uint curTid = GetCurrentThreadId();
            bool attached = false;
            try
            {
                IntPtr fg = GetForegroundWindow();
                if (fg != IntPtr.Zero && fg != targetHwnd)
                {
                    uint fgPid;
                    fgTid = GetWindowThreadProcessId(fg, out fgPid);
                    if (fgTid != 0 && fgTid != curTid)
                    {
                        attached = AttachThreadInput(fgTid, curTid, true);
                    }
                }
                BringWindowToTop(targetHwnd);
                SetForegroundWindow(targetHwnd);
            }
            catch { }
            finally
            {
                if (attached)
                {
                    try { AttachThreadInput(fgTid, curTid, false); } catch { }
                }
            }
        }

        [DllImport("user32.dll")]
        public static extern bool DestroyIcon(IntPtr hIcon);

        [DllImport("user32.dll")]
        public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        public static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);

        [DllImport("user32.dll")]
        public static extern bool SetCursorPos(int X, int Y);

        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int nIndex);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll", EntryPoint = "GetWindowLong")]
        private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")]
        private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
        private static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr")]
        private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        public static long GetWindowLongPtrCompat(IntPtr hWnd, int nIndex)
        {
            if (IntPtr.Size == 8) return GetWindowLongPtr64(hWnd, nIndex).ToInt64();
            return GetWindowLong32(hWnd, nIndex);
        }

        public static long SetWindowLongPtrCompat(IntPtr hWnd, int nIndex, long dwNewLong)
        {
            if (IntPtr.Size == 8) return SetWindowLongPtr64(hWnd, nIndex, new IntPtr(dwNewLong)).ToInt64();
            return SetWindowLong32(hWnd, nIndex, unchecked((int)dwNewLong));
        }

        [DllImport("user32.dll")]
        public static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint crKey, byte bAlpha, uint dwFlags);

        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(
            IntPtr hWnd,
            IntPtr hWndInsertAfter,
            int X,
            int Y,
            int cx,
            int cy,
            uint uFlags
        );

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        public static extern bool RedrawWindow(IntPtr hWnd, IntPtr lprcUpdate, IntPtr hrgnUpdate, uint flags);

        [DllImport("user32.dll")]
        public static extern IntPtr SetWinEventHook(
            uint eventMin,
            uint eventMax,
            IntPtr hmodWinEventProc,
            WinEventDelegate lpfnWinEventProc,
            uint idProcess,
            uint idThread,
            uint dwFlags
        );

        [DllImport("user32.dll")]
        public static extern bool UnhookWinEvent(IntPtr hWinEventHook);

        [DllImport("user32.dll")]
        public static extern IntPtr GetThreadDesktop(uint dwThreadId);

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern bool GetUserObjectInformation(
            IntPtr hObj,
            int nIndex,
            StringBuilder pvInfo,
            int nLength,
            out int lpnLengthNeeded
        );

        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

        [DllImport("user32.dll")]
        private static extern IntPtr SetProcessDpiAwarenessContext(IntPtr dpiContext);

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

        [DllImport("shcore.dll")]
        private static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);

        private const uint MONITOR_DEFAULTTONEAREST = 2;
        private const int MDT_EFFECTIVE_DPI = 0;

        public static void EnablePerMonitorDpi()
        {
            try
            {
                if (SetProcessDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return;
            }
            catch { }
            try
            {
                SetProcessDPIAware();
            }
            catch { }
        }

        public static double GetWindowDpiScale(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return 1.0;
            try
            {
                uint dpi = GetDpiForWindow(hwnd);
                if (dpi >= 72 && dpi <= 384)
                {
                    return dpi / 96.0;
                }
            }
            catch { }
            try
            {
                IntPtr hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                if (hmon != IntPtr.Zero)
                {
                    uint dx, dy;
                    if (GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, out dx, out dy) == 0 && dx >= 72 && dx <= 384)
                    {
                        return dx / 96.0;
                    }
                }
            }
            catch { }
            return 1.0;
        }

        public static bool TryGetVisibleBounds(IntPtr hwnd, out RECT rect)
        {
            rect = new RECT();
            try
            {
                int hr = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT)));
                if (hr == 0 && (rect.Right - rect.Left) > 0 && (rect.Bottom - rect.Top) > 0)
                {
                    return true;
                }
            }
            catch { }
            return GetWindowRect(hwnd, out rect);
        }

        public static bool IsWindowCloaked(IntPtr hwnd)
        {
            try
            {
                int cloaked = 0;
                int hr = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, Marshal.SizeOf(typeof(int)));
                return hr == 0 && cloaked != 0;
            }
            catch
            {
                return false;
            }
        }

        public static void SendLeftClickAt(int screenX, int screenY)
        {
            try
            {
                POINT prev;
                bool hadPrev = GetCursorPos(out prev);

                int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
                int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
                int vw = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
                int vh = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));

                int nx = (int)Math.Round(((screenX - vx) * 65535.0) / Math.Max(1, vw - 1));
                int ny = (int)Math.Round(((screenY - vy) * 65535.0) / Math.Max(1, vh - 1));

                INPUT[] inputs = new INPUT[3];
                inputs[0].type = INPUT_MOUSE;
                inputs[0].U.mi.dx = nx;
                inputs[0].U.mi.dy = ny;
                inputs[0].U.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;

                inputs[1].type = INPUT_MOUSE;
                inputs[1].U.mi.dx = nx;
                inputs[1].U.mi.dy = ny;
                inputs[1].U.mi.dwFlags = MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;

                inputs[2].type = INPUT_MOUSE;
                inputs[2].U.mi.dx = nx;
                inputs[2].U.mi.dy = ny;
                inputs[2].U.mi.dwFlags = MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;

                SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
                if (hadPrev)
                {
                    Thread.Sleep(25);
                    SetCursorPos(prev.X, prev.Y);
                }
            }
            catch { }
        }

        public static string GetDesktopName()
        {
            try
            {
                var sb = new StringBuilder(128);
                int needed = 0;
                if (GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()), 2, sb, sb.Capacity, out needed))
                {
                    return sb.ToString();
                }
            }
            catch { }
            return "unknown";
        }
    }

    internal static class ColorUtil
    {
        public static System.Windows.Media.Color ParseHex(string hex, System.Windows.Media.Color fallback)
        {
            if (string.IsNullOrEmpty(hex)) return fallback;
            string s = hex.Trim();
            if (s.StartsWith("#")) s = s.Substring(1);
            if (s.Length != 6) return fallback;
            try
            {
                byte r = Convert.ToByte(s.Substring(0, 2), 16);
                byte g = Convert.ToByte(s.Substring(2, 2), 16);
                byte b = Convert.ToByte(s.Substring(4, 2), 16);
                return System.Windows.Media.Color.FromRgb(r, g, b);
            }
            catch
            {
                return fallback;
            }
        }
    }

    internal sealed class BackdropSurfaceWindow : Window
    {
        private readonly Border _frameBorder;
        private readonly System.Windows.Controls.Image _image;
        private readonly System.Windows.Shapes.Rectangle _dimRect;
        private IntPtr _hwnd = IntPtr.Zero;
        private string _loadedPath = "";

        public IntPtr Handle { get { return _hwnd; } }

        public BackdropSurfaceWindow()
        {
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = System.Windows.Media.Brushes.Transparent;
            ShowInTaskbar = false;
            ShowActivated = false;
            Focusable = false;
            IsHitTestVisible = false;
            ResizeMode = ResizeMode.NoResize;
            Left = -32000;
            Top = -32000;
            Width = 100;
            Height = 100;

            _image = new System.Windows.Controls.Image
            {
                Stretch = Stretch.UniformToFill,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            RenderOptions.SetBitmapScalingMode(_image, BitmapScalingMode.HighQuality);

            _dimRect = new System.Windows.Shapes.Rectangle
            {
                Fill = new SolidColorBrush(System.Windows.Media.Color.FromRgb(7, 7, 9)),
                Opacity = 0.2
            };

            var grid = new Grid { ClipToBounds = true };
            grid.Children.Add(_image);
            grid.Children.Add(_dimRect);

            _frameBorder = new Border
            {
                CornerRadius = new CornerRadius(10),
                ClipToBounds = true,
                Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(7, 7, 9)),
                Child = grid
            };

            Content = _frameBorder;

            SourceInitialized += delegate
            {
                _hwnd = new WindowInteropHelper(this).Handle;
                long ex = Native.GetWindowLongPtrCompat(_hwnd, Native.GWL_EXSTYLE);
                ex |= Native.WS_EX_NOACTIVATE | Native.WS_EX_TOOLWINDOW | Native.WS_EX_TRANSPARENT;
                Native.SetWindowLongPtrCompat(_hwnd, Native.GWL_EXSTYLE, ex);
            };
        }

        public void ApplyVisuals(ThemeConfig cfg, BitmapSource sharedImage, bool isMaximized)
        {
            System.Windows.Media.Color canvasCol = ColorUtil.ParseHex(cfg.canvasColor, System.Windows.Media.Color.FromRgb(7, 7, 9));
            _frameBorder.Background = new SolidColorBrush(canvasCol);
            _dimRect.Fill = new SolidColorBrush(canvasCol);

            double imgOpacity = Math.Max(0.0, Math.Min(1.0, cfg.opacity / 100.0));
            _image.Opacity = imgOpacity;

            double dimFrac = Math.Max(0.0, Math.Min(0.85, cfg.dim / 100.0));
            _dimRect.Opacity = dimFrac;

            int radius = Math.Max(0, Math.Min(18, cfg.radius));
            _frameBorder.CornerRadius = isMaximized ? new CornerRadius(0) : new CornerRadius(radius);

            _image.Stretch = string.Equals(cfg.fit, "contain", StringComparison.OrdinalIgnoreCase)
                ? Stretch.Uniform
                : Stretch.UniformToFill;

            int blur = Math.Max(0, Math.Min(24, cfg.blur));
            if (blur > 0)
            {
                double effRadius = blur * 1.6;
                _image.Effect = new BlurEffect
                {
                    Radius = effRadius,
                    KernelType = KernelType.Gaussian,
                    RenderingBias = RenderingBias.Performance
                };
                double bleed = -(effRadius + 6);
                _image.Margin = new Thickness(bleed);
            }
            else
            {
                _image.Effect = null;
                _image.Margin = new Thickness(0);
            }

            if (!string.Equals(_loadedPath, cfg.wallpaperPath ?? "", StringComparison.OrdinalIgnoreCase) || _image.Source != sharedImage)
            {
                _loadedPath = cfg.wallpaperPath ?? "";
                _image.Source = sharedImage;
            }
        }
    }

    internal sealed class ImageLightboxWindow : Window
    {
        private readonly IntPtr _ownerHwnd;
        private readonly ScaleTransform _rootScale = new ScaleTransform(1.0, 1.0);
        private readonly Border _rootFrame;
        private readonly Grid _stageGrid;
        private readonly Border _imageFrame;
        private readonly System.Windows.Controls.Image _image;
        private readonly ScaleTransform _scaleTransform = new ScaleTransform(1.0, 1.0);
        private readonly TranslateTransform _translateTransform = new TranslateTransform(0.0, 0.0);
        private readonly TextBlock _nameText;
        private readonly TextBlock _dimText;
        private readonly TextBlock _zoomPctText;

        private IntPtr _hwnd = IntPtr.Zero;
        private string _filePath = "";
        private double _scale = 1.0;
        private bool _dragging = false;
        private System.Windows.Point _dragStart;
        private double _dragOriginX = 0.0;
        private double _dragOriginY = 0.0;
        private int _lastBoundsLeft = int.MinValue;
        private int _lastBoundsTop = int.MinValue;
        private int _lastBoundsW = -1;
        private int _lastBoundsH = -1;
        private double _lastBoundsDpi = -1.0;
        private bool _lastBoundsMax = false;
        private int _lastBoundsRadius = -1;

        public IntPtr Handle { get { return _hwnd; } }

        public ImageLightboxWindow(IntPtr ownerHwnd)
        {
            _ownerHwnd = ownerHwnd;
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = System.Windows.Media.Brushes.Transparent;
            ShowInTaskbar = false;
            ShowActivated = true;
            Focusable = true;
            ResizeMode = ResizeMode.NoResize;
            UseLayoutRounding = true;
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Ideal);
            TextOptions.SetTextRenderingMode(this, TextRenderingMode.ClearType);

            var uiFont = new System.Windows.Media.FontFamily("Segoe UI, Microsoft YaHei UI");
            var monoFont = new System.Windows.Media.FontFamily("Consolas, Segoe UI, Microsoft YaHei UI");

            _image = new System.Windows.Controls.Image
            {
                Stretch = Stretch.Uniform,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            RenderOptions.SetBitmapScalingMode(_image, BitmapScalingMode.HighQuality);

            var txGroup = new TransformGroup();
            txGroup.Children.Add(_scaleTransform);
            txGroup.Children.Add(_translateTransform);

            _imageFrame = new Border
            {
                CornerRadius = new CornerRadius(10),
                Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(20, 22, 29)),
                BorderThickness = new Thickness(1),
                BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(46, 255, 255, 255)),
                ClipToBounds = true,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                RenderTransformOrigin = new System.Windows.Point(0.5, 0.5),
                RenderTransform = txGroup,
                Cursor = System.Windows.Input.Cursors.Hand,
                Effect = new DropShadowEffect
                {
                    BlurRadius = 32,
                    ShadowDepth = 8,
                    Opacity = 0.72,
                    Color = Colors.Black
                },
                Child = _image
            };

            _imageFrame.MouseLeftButtonDown += OnImageMouseDown;
            _imageFrame.MouseMove += OnImageMouseMove;
            _imageFrame.MouseLeftButtonUp += OnImageMouseUp;
            _imageFrame.LostMouseCapture += delegate { EndDrag(); };

            _stageGrid = new Grid
            {
                ClipToBounds = true,
                Background = System.Windows.Media.Brushes.Transparent,
                Margin = new Thickness(28, 36, 28, 76)
            };
            _stageGrid.Children.Add(_imageFrame);
            _stageGrid.MouseLeftButtonDown += delegate(object s, MouseButtonEventArgs e)
            {
                if (e.OriginalSource == _stageGrid)
                {
                    e.Handled = true;
                    Close();
                }
            };

            // Top-right circular close button
            Border closeBtn = MakePillButton(
                "×",
                uiFont,
                18,
                FontWeights.Normal,
                System.Windows.Media.Color.FromArgb(230, 42, 46, 61),
                System.Windows.Media.Color.FromArgb(245, 62, 68, 88),
                System.Windows.Media.Color.FromArgb(62, 255, 255, 255),
                System.Windows.Media.Color.FromRgb(234, 233, 240),
                17,
                new Thickness(0)
            );
            closeBtn.Width = 34;
            closeBtn.Height = 34;
            closeBtn.HorizontalAlignment = System.Windows.HorizontalAlignment.Right;
            closeBtn.VerticalAlignment = VerticalAlignment.Top;
            closeBtn.Margin = new Thickness(0, 18, 18, 0);
            closeBtn.ToolTip = "关闭预览 (Esc)";
            closeBtn.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs e)
            {
                e.Handled = true;
                Close();
            };

            // Bottom floating capsule bar
            _nameText = new TextBlock
            {
                Text = "",
                FontFamily = monoFont,
                FontSize = 11.5,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(220, 220, 228)),
                VerticalAlignment = VerticalAlignment.Center,
                MaxWidth = 220,
                TextTrimming = TextTrimming.CharacterEllipsis
            };

            _dimText = new TextBlock
            {
                Text = "",
                FontFamily = monoFont,
                FontSize = 10.5,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(138, 140, 154)),
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(6, 0, 0, 0)
            };

            var zoomOutBtn = MakePillButton(
                "−",
                uiFont,
                13,
                FontWeights.SemiBold,
                System.Windows.Media.Color.FromArgb(0, 0, 0, 0),
                System.Windows.Media.Color.FromArgb(220, 56, 62, 82),
                System.Windows.Media.Color.FromArgb(0, 0, 0, 0),
                System.Windows.Media.Color.FromRgb(226, 226, 234),
                6,
                new Thickness(0)
            );
            zoomOutBtn.Width = 24;
            zoomOutBtn.Height = 22;
            zoomOutBtn.ToolTip = "缩小 (-)";
            zoomOutBtn.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs e)
            {
                e.Handled = true;
                SetZoom(_scale / 1.25);
            };

            _zoomPctText = new TextBlock
            {
                Text = "100%",
                FontFamily = monoFont,
                FontSize = 11,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(226, 226, 234)),
                VerticalAlignment = VerticalAlignment.Center,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center
            };
            var zoomResetBtn = new Border
            {
                Height = 22,
                MinWidth = 44,
                Padding = new Thickness(6, 0, 6, 0),
                CornerRadius = new CornerRadius(6),
                Background = System.Windows.Media.Brushes.Transparent,
                Cursor = System.Windows.Input.Cursors.Hand,
                ToolTip = "还原 100% (0)",
                Child = _zoomPctText
            };
            zoomResetBtn.MouseEnter += delegate { zoomResetBtn.Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(220, 56, 62, 82)); };
            zoomResetBtn.MouseLeave += delegate { zoomResetBtn.Background = System.Windows.Media.Brushes.Transparent; };
            zoomResetBtn.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs e)
            {
                e.Handled = true;
                SetZoom(1.0);
            };

            var zoomInBtn = MakePillButton(
                "+",
                uiFont,
                13,
                FontWeights.SemiBold,
                System.Windows.Media.Color.FromArgb(0, 0, 0, 0),
                System.Windows.Media.Color.FromArgb(220, 56, 62, 82),
                System.Windows.Media.Color.FromArgb(0, 0, 0, 0),
                System.Windows.Media.Color.FromRgb(226, 226, 234),
                6,
                new Thickness(0)
            );
            zoomInBtn.Width = 24;
            zoomInBtn.Height = 22;
            zoomInBtn.ToolTip = "放大 (+)";
            zoomInBtn.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs e)
            {
                e.Handled = true;
                SetZoom(_scale * 1.25);
            };

            var zoomRow = new StackPanel
            {
                Orientation = System.Windows.Controls.Orientation.Horizontal,
                VerticalAlignment = VerticalAlignment.Center
            };
            zoomRow.Children.Add(zoomOutBtn);
            zoomRow.Children.Add(zoomResetBtn);
            zoomRow.Children.Add(zoomInBtn);

            var zoomCapsule = new Border
            {
                CornerRadius = new CornerRadius(8),
                Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(20, 22, 30)),
                BorderThickness = new Thickness(1),
                BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(30, 255, 255, 255)),
                Padding = new Thickness(2),
                Margin = new Thickness(10, 0, 10, 0),
                Child = zoomRow
            };

            var openFileBtn = MakePillButton(
                "打开文件",
                uiFont,
                11.5,
                FontWeights.Medium,
                System.Windows.Media.Color.FromRgb(38, 42, 56),
                System.Windows.Media.Color.FromRgb(52, 58, 76),
                System.Windows.Media.Color.FromArgb(46, 255, 255, 255),
                System.Windows.Media.Color.FromRgb(234, 233, 240),
                12,
                new Thickness(11, 4, 11, 4)
            );
            openFileBtn.ToolTip = "使用系统默认程序打开图片";
            openFileBtn.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs e)
            {
                e.Handled = true;
                OpenTargetFile();
            };

            var openFolderBtn = MakePillButton(
                "打开所在位置 ↗",
                uiFont,
                11.5,
                FontWeights.SemiBold,
                System.Windows.Media.Color.FromRgb(28, 74, 56),
                System.Windows.Media.Color.FromRgb(36, 98, 74),
                System.Windows.Media.Color.FromArgb(145, 66, 198, 138),
                System.Windows.Media.Color.FromRgb(118, 245, 184),
                12,
                new Thickness(12, 4, 12, 4)
            );
            openFolderBtn.Margin = new Thickness(7, 0, 0, 0);
            openFolderBtn.ToolTip = "在文件管理器中定位并选中该文件";
            openFolderBtn.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs e)
            {
                e.Handled = true;
                OpenTargetFolder();
            };

            var barStack = new StackPanel
            {
                Orientation = System.Windows.Controls.Orientation.Horizontal,
                VerticalAlignment = VerticalAlignment.Center
            };
            barStack.Children.Add(_nameText);
            barStack.Children.Add(_dimText);
            barStack.Children.Add(zoomCapsule);
            barStack.Children.Add(openFileBtn);
            barStack.Children.Add(openFolderBtn);

            var bottomBar = new Border
            {
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Bottom,
                Margin = new Thickness(20, 0, 20, 20),
                Padding = new Thickness(12, 6, 10, 6),
                CornerRadius = new CornerRadius(14),
                Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(245, 26, 29, 40)),
                BorderThickness = new Thickness(1),
                BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(46, 255, 255, 255)),
                Effect = new DropShadowEffect
                {
                    BlurRadius = 22,
                    ShadowDepth = 4,
                    Opacity = 0.65,
                    Color = Colors.Black
                },
                Child = barStack
            };
            bottomBar.MouseLeftButtonDown += delegate(object s, MouseButtonEventArgs e) { e.Handled = true; };

            var rootGrid = new Grid();
            rootGrid.Children.Add(_stageGrid);
            rootGrid.Children.Add(bottomBar);
            rootGrid.Children.Add(closeBtn);

            _rootFrame = new Border
            {
                CornerRadius = new CornerRadius(10),
                ClipToBounds = true,
                Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(236, 15, 17, 24)),
                LayoutTransform = _rootScale,
                Child = rootGrid
            };
            _rootFrame.MouseLeftButtonDown += delegate(object s, MouseButtonEventArgs e)
            {
                if (e.OriginalSource == _rootFrame || e.OriginalSource == rootGrid)
                {
                    e.Handled = true;
                    Close();
                }
            };

            Content = _rootFrame;

            PreviewMouseWheel += OnLightboxMouseWheel;
            PreviewKeyDown += OnLightboxKeyDown;

            SourceInitialized += delegate
            {
                _hwnd = new WindowInteropHelper(this).Handle;
                long ex = Native.GetWindowLongPtrCompat(_hwnd, Native.GWL_EXSTYLE);
                ex |= Native.WS_EX_TOOLWINDOW;
                Native.SetWindowLongPtrCompat(_hwnd, Native.GWL_EXSTYLE, ex);
                if (_ownerHwnd != IntPtr.Zero && Native.IsWindow(_ownerHwnd))
                {
                    Native.SetWindowLongPtrCompat(_hwnd, Native.GWLP_HWNDPARENT, _ownerHwnd.ToInt64());
                }
            };
        }

        private static Border MakePillButton(
            string text,
            System.Windows.Media.FontFamily font,
            double fontSize,
            FontWeight weight,
            System.Windows.Media.Color bg,
            System.Windows.Media.Color hoverBg,
            System.Windows.Media.Color border,
            System.Windows.Media.Color fg,
            double radius,
            Thickness padding)
        {
            var tb = new TextBlock
            {
                Text = text,
                FontFamily = font,
                FontSize = fontSize,
                FontWeight = weight,
                Foreground = new SolidColorBrush(fg),
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            var normalBrush = new SolidColorBrush(bg);
            var hoverBrush = new SolidColorBrush(hoverBg);
            var btn = new Border
            {
                CornerRadius = new CornerRadius(radius),
                Background = normalBrush,
                BorderThickness = border.A > 0 ? new Thickness(1) : new Thickness(0),
                BorderBrush = new SolidColorBrush(border),
                Padding = padding,
                Cursor = System.Windows.Input.Cursors.Hand,
                Child = tb
            };
            btn.MouseEnter += delegate { btn.Background = hoverBrush; };
            btn.MouseLeave += delegate { btn.Background = normalBrush; };
            return btn;
        }

        public bool LoadImage(string filePath, string label)
        {
            if (string.IsNullOrEmpty(filePath) || !File.Exists(filePath)) return false;
            try
            {
                byte[] bytes = File.ReadAllBytes(filePath);
                if (bytes.Length == 0 || bytes.Length > 15 * 1024 * 1024) return false;
                BitmapImage bmp = new BitmapImage();
                using (var ms = new MemoryStream(bytes))
                {
                    bmp.BeginInit();
                    bmp.CacheOption = BitmapCacheOption.OnLoad;
                    bmp.StreamSource = ms;
                    bmp.EndInit();
                }
                bmp.Freeze();
                _filePath = filePath;
                _image.Source = bmp;
                _nameText.Text = string.IsNullOrEmpty(label) ? System.IO.Path.GetFileName(filePath) : label;
                _nameText.ToolTip = filePath;
                _dimText.Text = string.Format("{0}×{1}", bmp.PixelWidth, bmp.PixelHeight);
                SetZoom(1.0);
                return true;
            }
            catch
            {
                return false;
            }
        }

        public void PositionOverBounds(Native.RECT winRect, double dpiScale, bool isMaximized, int radius)
        {
            PositionOverBounds(winRect, dpiScale, isMaximized, radius, false);
        }

        public void PositionOverBounds(Native.RECT winRect, double dpiScale, bool isMaximized, int radius, bool noActivate)
        {
            double safeScale = Math.Max(0.5, dpiScale);
            int physW = Math.Max(320, winRect.Right - winRect.Left);
            int physH = Math.Max(240, winRect.Bottom - winRect.Top);

            if (noActivate &&
                _hwnd != IntPtr.Zero &&
                winRect.Left == _lastBoundsLeft &&
                winRect.Top == _lastBoundsTop &&
                physW == _lastBoundsW &&
                physH == _lastBoundsH &&
                Math.Abs(safeScale - _lastBoundsDpi) < 0.01 &&
                isMaximized == _lastBoundsMax &&
                radius == _lastBoundsRadius)
            {
                return;
            }

            double wpfDpiX = 1.0;
            double wpfDpiY = 1.0;
            try
            {
                PresentationSource src = PresentationSource.FromVisual(this);
                if (src != null && src.CompositionTarget != null)
                {
                    Matrix m = src.CompositionTarget.TransformToDevice;
                    if (m.M11 > 0.1) wpfDpiX = m.M11;
                    if (m.M22 > 0.1) wpfDpiY = m.M22;
                }
            }
            catch { }

            double relX = safeScale / wpfDpiX;
            double relY = safeScale / wpfDpiY;
            _rootScale.ScaleX = relX;
            _rootScale.ScaleY = relY;

            double logicalDipW = physW / safeScale;
            double logicalDipH = physH / safeScale;

            _rootFrame.CornerRadius = isMaximized ? new CornerRadius(0) : new CornerRadius(Math.Max(0, Math.Min(18, radius)));
            _image.MaxWidth = Math.Max(180.0, logicalDipW - 96.0);
            _image.MaxHeight = Math.Max(120.0, logicalDipH - 136.0);

            Left = winRect.Left / wpfDpiX;
            Top = winRect.Top / wpfDpiY;
            Width = physW / wpfDpiX;
            Height = physH / wpfDpiY;

            if (_hwnd != IntPtr.Zero && Native.IsWindow(_hwnd))
            {
                uint flags = Native.SWP_NOZORDER | Native.SWP_SHOWWINDOW;
                if (noActivate) flags |= Native.SWP_NOACTIVATE;
                Native.SetWindowPos(_hwnd, IntPtr.Zero, winRect.Left, winRect.Top, physW, physH, flags);
            }

            _lastBoundsLeft = winRect.Left;
            _lastBoundsTop = winRect.Top;
            _lastBoundsW = physW;
            _lastBoundsH = physH;
            _lastBoundsDpi = safeScale;
            _lastBoundsMax = isMaximized;
            _lastBoundsRadius = radius;
        }

        private void SetZoom(double nextScale)
        {
            _scale = Math.Max(0.25, Math.Min(5.0, nextScale));
            if (_scale <= 1.02)
            {
                _translateTransform.X = 0.0;
                _translateTransform.Y = 0.0;
                _imageFrame.Cursor = System.Windows.Input.Cursors.Hand;
            }
            else
            {
                _imageFrame.Cursor = System.Windows.Input.Cursors.SizeAll;
            }
            _scaleTransform.ScaleX = _scale;
            _scaleTransform.ScaleY = _scale;
            _zoomPctText.Text = string.Format("{0}%", (int)Math.Round(_scale * 100.0));
        }

        private void OnLightboxMouseWheel(object sender, MouseWheelEventArgs e)
        {
            e.Handled = true;
            double factor = e.Delta > 0 ? 1.15 : (1.0 / 1.15);
            SetZoom(_scale * factor);
        }

        private void OnLightboxKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
        {
            if (e.Key == Key.Escape)
            {
                e.Handled = true;
                Close();
            }
            else if (e.Key == Key.Add || e.Key == Key.OemPlus)
            {
                e.Handled = true;
                SetZoom(_scale * 1.25);
            }
            else if (e.Key == Key.Subtract || e.Key == Key.OemMinus)
            {
                e.Handled = true;
                SetZoom(_scale / 1.25);
            }
            else if (e.Key == Key.D0 || e.Key == Key.NumPad0)
            {
                e.Handled = true;
                SetZoom(1.0);
            }
        }

        private void OnImageMouseDown(object sender, MouseButtonEventArgs e)
        {
            e.Handled = true;
            if (e.ClickCount == 2)
            {
                SetZoom(_scale > 1.1 ? 1.0 : 2.0);
                return;
            }
            if (_scale > 1.02)
            {
                _dragging = true;
                _dragStart = e.GetPosition(this);
                _dragOriginX = _translateTransform.X;
                _dragOriginY = _translateTransform.Y;
                _imageFrame.CaptureMouse();
            }
        }

        private void OnImageMouseMove(object sender, System.Windows.Input.MouseEventArgs e)
        {
            if (!_dragging) return;
            System.Windows.Point cur = e.GetPosition(this);
            _translateTransform.X = _dragOriginX + (cur.X - _dragStart.X);
            _translateTransform.Y = _dragOriginY + (cur.Y - _dragStart.Y);
        }

        private void OnImageMouseUp(object sender, MouseButtonEventArgs e)
        {
            EndDrag();
        }

        private void EndDrag()
        {
            if (!_dragging) return;
            _dragging = false;
            try { _imageFrame.ReleaseMouseCapture(); } catch { }
        }

        private void OpenTargetFile()
        {
            if (string.IsNullOrEmpty(_filePath) || !File.Exists(_filePath)) return;
            try
            {
                using (Process proc = Process.Start(new ProcessStartInfo(_filePath) { UseShellExecute = true }))
                {
                }
            }
            catch { }
        }

        private void OpenTargetFolder()
        {
            if (string.IsNullOrEmpty(_filePath)) return;
            try
            {
                string fullPath = System.IO.Path.GetFullPath(_filePath);
                if (File.Exists(fullPath))
                {
                    IntPtr pidl = IntPtr.Zero;
                    uint sfgaoOut = 0;
                    try
                    {
                        if (Native.SHParseDisplayName(fullPath, IntPtr.Zero, out pidl, 0, out sfgaoOut) == 0 && pidl != IntPtr.Zero)
                        {
                            if (Native.SHOpenFolderAndSelectItems(pidl, 0, IntPtr.Zero, 0) == 0)
                            {
                                return;
                            }
                        }
                    }
                    finally
                    {
                        if (pidl != IntPtr.Zero) Native.CoTaskMemFree(pidl);
                    }
                    using (Process proc = Process.Start("explorer.exe", "/select,\"" + fullPath + "\""))
                    {
                    }
                }
                else
                {
                    string parent = System.IO.Path.GetDirectoryName(fullPath);
                    if (!string.IsNullOrEmpty(parent) && Directory.Exists(parent))
                    {
                        using (Process proc = Process.Start("explorer.exe", "\"" + parent + "\""))
                        {
                        }
                    }
                }
            }
            catch { }
        }
    }

    internal sealed class HudOverlayWindow : Window
    {
        public const double DipWidth = 360.0;
        public const double DipHeight = 26.0;

        private readonly IntPtr _ownerHwnd;
        private readonly ScaleTransform _rootScale = new ScaleTransform(1.0, 1.0);
        private readonly Border _ringPill;
        private readonly System.Windows.Shapes.Ellipse _ringTrack;
        private readonly System.Windows.Shapes.Path _ringArc;
        private readonly TextBlock _pctText;
        private readonly Border _metaPill;
        private readonly TextBlock _speedText;
        private readonly TextBlock _modelText;

        private IntPtr _hwnd = IntPtr.Zero;
        private int _lastPercent = -1;
        private string _lastAccentHex = "";
        private double _lastRelScaleX = 1.0;
        private double _lastRelScaleY = 1.0;

        public event Action Clicked;
        public IntPtr Handle { get { return _hwnd; } }

        public HudOverlayWindow(IntPtr ownerHwnd)
        {
            _ownerHwnd = ownerHwnd;
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = System.Windows.Media.Brushes.Transparent;
            ShowInTaskbar = false;
            ShowActivated = false;
            Focusable = false;
            ResizeMode = ResizeMode.NoResize;
            UseLayoutRounding = true;
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Ideal);
            TextOptions.SetTextRenderingMode(this, TextRenderingMode.ClearType);
            Left = -32000;
            Top = -32000;
            Width = DipWidth;
            Height = DipHeight;

            var uiFont = new System.Windows.Media.FontFamily("Segoe UI, Microsoft YaHei UI");

            // Left pill: bare 2-color ring when idle; hover reveals rounded pill with ring + "* %"
            _ringTrack = new System.Windows.Shapes.Ellipse
            {
                Width = 14,
                Height = 14,
                Stroke = new SolidColorBrush(System.Windows.Media.Color.FromArgb(72, 255, 255, 255)),
                StrokeThickness = 2.0,
                Fill = System.Windows.Media.Brushes.Transparent
            };

            _ringArc = new System.Windows.Shapes.Path
            {
                Stroke = new SolidColorBrush(System.Windows.Media.Color.FromRgb(91, 140, 255)),
                StrokeThickness = 2.0,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round,
                Fill = System.Windows.Media.Brushes.Transparent
            };

            var ringCanvas = new Grid
            {
                Width = 14,
                Height = 14,
                VerticalAlignment = VerticalAlignment.Center
            };
            ringCanvas.Children.Add(_ringTrack);
            ringCanvas.Children.Add(_ringArc);

            _pctText = new TextBlock
            {
                Text = "0%",
                FontFamily = uiFont,
                FontSize = 11,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(234, 233, 239)),
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(5, 0, 0, 0),
                Visibility = Visibility.Collapsed
            };

            var ringInner = new StackPanel
            {
                Orientation = System.Windows.Controls.Orientation.Horizontal,
                VerticalAlignment = VerticalAlignment.Center
            };
            ringInner.Children.Add(ringCanvas);
            ringInner.Children.Add(_pctText);

            _ringPill = new Border
            {
                Height = 22,
                CornerRadius = new CornerRadius(11),
                BorderThickness = new Thickness(1),
                VerticalAlignment = VerticalAlignment.Center,
                Cursor = System.Windows.Input.Cursors.Hand,
                Child = ringInner
            };
            ApplyRingHoverStyle(false);

            _ringPill.MouseEnter += delegate
            {
                ApplyRingHoverStyle(true);
            };
            _ringPill.MouseLeave += delegate
            {
                ApplyRingHoverStyle(false);
            };
            _ringPill.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs e)
            {
                e.Handled = true;
                Action handler = Clicked;
                if (handler != null) handler();
            };

            // Right pill: minimal tok/s + upstream model ID
            _speedText = new TextBlock
            {
                Text = "-- tok/s",
                FontFamily = uiFont,
                FontSize = 11,
                FontWeight = FontWeights.Medium,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(226, 225, 232)),
                VerticalAlignment = VerticalAlignment.Center
            };

            var dotText = new TextBlock
            {
                Text = " · ",
                FontFamily = uiFont,
                FontSize = 11,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromArgb(110, 255, 255, 255)),
                VerticalAlignment = VerticalAlignment.Center
            };

            _modelText = new TextBlock
            {
                Text = "--",
                FontFamily = uiFont,
                FontSize = 11,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(182, 181, 192)),
                VerticalAlignment = VerticalAlignment.Center,
                MaxWidth = 152,
                TextTrimming = TextTrimming.CharacterEllipsis
            };

            var metaInner = new StackPanel
            {
                Orientation = System.Windows.Controls.Orientation.Horizontal,
                VerticalAlignment = VerticalAlignment.Center
            };
            metaInner.Children.Add(_speedText);
            metaInner.Children.Add(dotText);
            metaInner.Children.Add(_modelText);

            _metaPill = new Border
            {
                Height = 22,
                Margin = new Thickness(6, 0, 0, 0),
                Padding = new Thickness(8, 0, 8, 0),
                CornerRadius = new CornerRadius(11),
                BorderThickness = new Thickness(1),
                VerticalAlignment = VerticalAlignment.Center,
                Cursor = System.Windows.Input.Cursors.Hand,
                Child = metaInner
            };
            ApplyMetaHoverStyle(false);

            _metaPill.MouseEnter += delegate
            {
                ApplyMetaHoverStyle(true);
            };
            _metaPill.MouseLeave += delegate
            {
                ApplyMetaHoverStyle(false);
            };
            _metaPill.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs e)
            {
                e.Handled = true;
                Action handler = Clicked;
                if (handler != null) handler();
            };

            var row = new StackPanel
            {
                Orientation = System.Windows.Controls.Orientation.Horizontal,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Center
            };
            row.Children.Add(_ringPill);
            row.Children.Add(_metaPill);

            // Outer Grid keeps Background = null so transparent left area is 100% click-through
            var root = new Grid
            {
                Width = DipWidth,
                Height = DipHeight,
                Background = null,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Top,
                LayoutTransform = _rootScale
            };
            root.Children.Add(row);
            Content = root;

            SourceInitialized += delegate
            {
                _hwnd = new WindowInteropHelper(this).Handle;
                long ex = Native.GetWindowLongPtrCompat(_hwnd, Native.GWL_EXSTYLE);
                ex |= Native.WS_EX_NOACTIVATE | Native.WS_EX_TOOLWINDOW;
                Native.SetWindowLongPtrCompat(_hwnd, Native.GWL_EXSTYLE, ex);
                if (_ownerHwnd != IntPtr.Zero && Native.IsWindow(_ownerHwnd))
                {
                    Native.SetWindowLongPtrCompat(_hwnd, Native.GWLP_HWNDPARENT, _ownerHwnd.ToInt64());
                }
            };
        }

        private void ApplyRingHoverStyle(bool hovered)
        {
            if (hovered)
            {
                _ringPill.Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(228, 22, 24, 32));
                _ringPill.BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(58, 255, 255, 255));
                _ringPill.Padding = new Thickness(6, 0, 7, 0);
                _pctText.Visibility = Visibility.Visible;
            }
            else
            {
                // Alpha = 1 keeps hover hit-testing responsive while appearing visually bare
                _ringPill.Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(1, 20, 22, 29));
                _ringPill.BorderBrush = System.Windows.Media.Brushes.Transparent;
                _ringPill.Padding = new Thickness(3, 0, 3, 0);
                _pctText.Visibility = Visibility.Collapsed;
            }
        }

        private void ApplyMetaHoverStyle(bool hovered)
        {
            if (hovered)
            {
                _metaPill.Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(232, 28, 31, 41));
                _metaPill.BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(68, 255, 255, 255));
            }
            else
            {
                _metaPill.Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(192, 19, 21, 28));
                _metaPill.BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(40, 255, 255, 255));
            }
        }

        public void UpdateData(HudTelemetry data, string accentHex)
        {
            int pct = data != null ? Math.Max(0, Math.Min(100, data.percent)) : 0;
            string accent = string.IsNullOrEmpty(accentHex) ? "#5B8CFF" : accentHex;

            if (pct != _lastPercent || !string.Equals(accent, _lastAccentHex, StringComparison.OrdinalIgnoreCase))
            {
                _lastPercent = pct;
                _lastAccentHex = accent;
                _pctText.Text = string.Format("{0}%", pct);

                System.Windows.Media.Color arcColor;
                if (pct >= 90)
                {
                    arcColor = System.Windows.Media.Color.FromRgb(239, 83, 80);
                }
                else if (pct >= 75)
                {
                    arcColor = System.Windows.Media.Color.FromRgb(233, 147, 21);
                }
                else
                {
                    arcColor = ColorUtil.ParseHex(accent, System.Windows.Media.Color.FromRgb(91, 140, 255));
                }
                _ringArc.Stroke = new SolidColorBrush(arcColor);
                _ringArc.Data = BuildArcGeometry(pct);
            }

            if (data != null && data.tokPerSec.HasValue && data.tokPerSec.Value > 0)
            {
                double val = data.tokPerSec.Value;
                string num = val >= 100
                    ? Math.Round(val).ToString("0", CultureInfo.InvariantCulture)
                    : val.ToString("0.0", CultureInfo.InvariantCulture);
                _speedText.Text = num + " tok/s";
            }
            else
            {
                _speedText.Text = "-- tok/s";
            }

            string modelId = (data != null && !string.IsNullOrEmpty(data.upstreamModelId))
                ? data.upstreamModelId
                : "--";
            _modelText.Text = modelId;
        }

        public bool ApplyDpiScale(double targetDpiScale, out int physW, out int physH)
        {
            double clampedTarget = Math.Max(0.75, Math.Min(3.5, targetDpiScale));
            double wpfDpiX = 1.0;
            double wpfDpiY = 1.0;
            try
            {
                PresentationSource src = PresentationSource.FromVisual(this);
                if (src != null && src.CompositionTarget != null)
                {
                    Matrix m = src.CompositionTarget.TransformToDevice;
                    if (m.M11 > 0.1) wpfDpiX = m.M11;
                    if (m.M22 > 0.1) wpfDpiY = m.M22;
                }
            }
            catch { }

            // Compensate for .NET 4.x WPF locking TransformToDevice to the primary monitor's DPI
            double relX = clampedTarget / wpfDpiX;
            double relY = clampedTarget / wpfDpiY;
            bool changed = Math.Abs(relX - _lastRelScaleX) > 0.01 || Math.Abs(relY - _lastRelScaleY) > 0.01;
            if (changed)
            {
                _lastRelScaleX = relX;
                _lastRelScaleY = relY;
                _rootScale.ScaleX = relX;
                _rootScale.ScaleY = relY;
                Width = DipWidth * relX;
                Height = DipHeight * relY;
                try { UpdateLayout(); } catch { }
            }

            physW = (int)Math.Ceiling(DipWidth * clampedTarget);
            physH = (int)Math.Ceiling(DipHeight * clampedTarget);
            return changed;
        }

        public void SetAvailableDipWidth(double availDip)
        {
            if (availDip < 110.0)
            {
                if (_metaPill.Visibility != Visibility.Collapsed)
                {
                    _metaPill.Visibility = Visibility.Collapsed;
                }
            }
            else
            {
                if (_metaPill.Visibility != Visibility.Visible)
                {
                    _metaPill.Visibility = Visibility.Visible;
                }
                double nextMax = Math.Max(36.0, Math.Min(152.0, availDip - 118.0));
                if (Math.Abs(_modelText.MaxWidth - nextMax) >= 2.0)
                {
                    _modelText.MaxWidth = nextMax;
                }
            }
        }

        private static Geometry BuildArcGeometry(int pct)
        {
            if (pct <= 0) return Geometry.Empty;
            const double cx = 7.0;
            const double cy = 7.0;
            const double r = 6.0;

            if (pct >= 100)
            {
                var full = new EllipseGeometry(new System.Windows.Point(cx, cy), r, r);
                full.Freeze();
                return full;
            }

            double clampedPct = Math.Max(2.0, Math.Min(99.5, (double)pct));
            double angleRad = (clampedPct / 100.0) * Math.PI * 2.0;
            double startX = cx;
            double startY = cy - r;
            double endX = cx + r * Math.Sin(angleRad);
            double endY = cy - r * Math.Cos(angleRad);
            bool isLargeArc = clampedPct > 50.0;

            var geom = new StreamGeometry();
            using (StreamGeometryContext ctx = geom.Open())
            {
                ctx.BeginFigure(new System.Windows.Point(startX, startY), false, false);
                ctx.ArcTo(
                    new System.Windows.Point(endX, endY),
                    new System.Windows.Size(r, r),
                    0.0,
                    isLargeArc,
                    SweepDirection.Clockwise,
                    true,
                    false
                );
            }
            geom.Freeze();
            return geom;
        }
    }

    internal static class UiaHelper
    {
        private static readonly string[] ModeKeywords = new string[]
        {
            "turbo", "planning", "fast", "auto", "strict", "review", "proceed", "sandbox", "permission", "ask",
            "极速", "规划", "快速", "自动", "严格", "审查", "权限"
        };

        private static readonly string[] MicKeywords = new string[]
        {
            "microphone", "voice", "dictate", "speech", "audio", "麦克风", "语音"
        };

        private static readonly string[] SendStopKeywords = new string[]
        {
            "send", "stop", "submit", "cancel", "发送", "停止"
        };

        private static readonly string[] SidePaneToggleKeywords = new string[]
        {
            "side pane", "auxiliary", "right pane", "secondary side", "toggle side", "toggle panel",
            "side bar", "sidebar", "open panel", "侧边栏", "辅助面板", "右侧面板"
        };

        private static readonly string[] WindowChromeExclude = new string[]
        {
            "close", "minimize", "maximize", "restore", "关闭", "最小化", "最大化", "还原"
        };

        private static bool ContainsAny(string haystack, string[] needles)
        {
            if (string.IsNullOrEmpty(haystack)) return false;
            string low = haystack.ToLowerInvariant();
            for (int i = 0; i < needles.Length; i++)
            {
                if (low.Contains(needles[i])) return true;
            }
            return false;
        }

        private static readonly string[] HeaderChromeIgnore = new string[]
        {
            "antigravity", "workspace", "view", "window", "file", "edit", "help",
            "new conversation", "automations", "customizations", "settings", "projects",
            "project options", "filter projects", "new project", "add project", "sort",
            "search", "back", "forward", "toggle sidebar", "collapse", "expand",
            "swarm", "agy 控制台", "antigravity monitor", "review", "ask anything"
        };

        private static bool IsHeaderChromeText(string text)
        {
            if (string.IsNullOrEmpty(text)) return true;
            string t = text.Trim();
            if (t.Length <= 1) return true;
            string low = t.ToLowerInvariant();
            for (int i = 0; i < HeaderChromeIgnore.Length; i++)
            {
                if (low == HeaderChromeIgnore[i] || low.StartsWith("swarm worker")) return true;
            }
            if (low.EndsWith(".mjs") || low.EndsWith(".js") || low.EndsWith(".ts") || low.EndsWith(".cs") || low.EndsWith(".json")) return true;
            if (low.Contains("window.") || low.Contains("sidecar.") || low.Contains("document.") || low.Contains("()")) return true;
            return false;
        }

        private static bool TryGetValidRect(AutomationElement el, out System.Windows.Rect rect)
        {
            rect = System.Windows.Rect.Empty;
            if (el == null) return false;
            try
            {
                rect = el.Current.BoundingRectangle;
                if (rect.IsEmpty || double.IsNaN(rect.Left) || double.IsInfinity(rect.Left)) return false;
                if (rect.Width <= 1 || rect.Height <= 1) return false;
                return true;
            }
            catch
            {
                return false;
            }
        }

        public static HudAnchorInfo ProbeComposerAnchor(
            IntPtr hwnd,
            Native.RECT winRect,
            ref AutomationElement cachedAnchor,
            ref int cachedKind,
            ref AutomationElement cachedLeftGuard
        )
        {
            var result = new HudAnchorInfo
            {
                HasAnchor = false,
                ComposerVisible = true,
                FromUia = false,
                RightX = winRect.Left + (int)Math.Round((winRect.Right - winRect.Left) * 0.56),
                LeftGuardX = winRect.Left + 240,
                CenterY = winRect.Bottom - 36,
                AnchorWinLeft = winRect.Left,
                AnchorWinTop = winRect.Top,
                AnchorWinRight = winRect.Right,
                AnchorWinBottom = winRect.Bottom
            };

            double dpiScale = Native.GetWindowDpiScale(hwnd);
            int winH = Math.Max(1, winRect.Bottom - winRect.Top);
            int bandTop = winRect.Bottom - Math.Min((int)Math.Round(170 * dpiScale), Math.Max((int)Math.Round(110 * dpiScale), winH / 4));
            int bandBottom = winRect.Bottom - (int)Math.Round(4 * dpiScale);
            int minBtnLeft = winRect.Left + (int)Math.Round(180 * dpiScale);
            int defaultLeftGuard = winRect.Left + (int)Math.Round(220 * dpiScale);
            int rowAlignTol = (int)Math.Round(16 * dpiScale);

            // Fast path: reuse cached UIA anchor element (<0.5ms)
            if (cachedAnchor != null)
            {
                System.Windows.Rect cr;
                if (TryGetValidRect(cachedAnchor, out cr) &&
                    cr.Top >= bandTop && cr.Bottom <= bandBottom &&
                    cr.Left >= minBtnLeft && cr.Right <= winRect.Right - 4)
                {
                    int baseShift = cachedKind == 1 ? 6 : (cachedKind == 2 ? 36 : 86);
                    int extraShift = (int)Math.Round(baseShift * dpiScale);
                    int rX = (int)Math.Round(cr.Left) - extraShift;
                    int lGuard = defaultLeftGuard;
                    if (cachedLeftGuard != null)
                    {
                        System.Windows.Rect lr;
                        if (TryGetValidRect(cachedLeftGuard, out lr) &&
                            Math.Abs(((lr.Top + lr.Bottom) / 2.0) - ((cr.Top + cr.Bottom) / 2.0)) <= rowAlignTol &&
                            lr.Right < rX)
                        {
                            lGuard = (int)Math.Round(lr.Right) + (int)Math.Round(6 * dpiScale);
                        }
                    }
                    result.HasAnchor = true;
                    result.ComposerVisible = true;
                    result.FromUia = true;
                    result.RightX = rX;
                    result.LeftGuardX = lGuard;
                    result.CenterY = (int)Math.Round((cr.Top + cr.Bottom) / 2.0);
                    return result;
                }
                cachedAnchor = null;
                cachedKind = 0;
                cachedLeftGuard = null;
            }

            try
            {
                AutomationElement root = AutomationElement.FromHandle(hwnd);
                if (root == null) return result;

                AutomationElementCollection buttons = root.FindAll(
                    TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)
                );

                if (buttons == null || buttons.Count == 0)
                {
                    return result;
                }

                AutomationElement modeMatch = null;
                System.Windows.Rect modeRect = System.Windows.Rect.Empty;
                AutomationElement micMatch = null;
                System.Windows.Rect micRect = System.Windows.Rect.Empty;
                AutomationElement sendMatch = null;
                System.Windows.Rect sendRect = System.Windows.Rect.Empty;
                var rowButtons = new List<KeyValuePair<AutomationElement, System.Windows.Rect>>();
                int bottomButtonCount = 0;

                double minBtnH = 14.0 * dpiScale;
                double maxBtnH = 54.0 * dpiScale;
                double minModeW = 16.0 * dpiScale;
                double maxModeW = 170.0 * dpiScale;
                double maxIconW = 56.0 * dpiScale;

                for (int i = 0; i < buttons.Count; i++)
                {
                    AutomationElement btn = buttons[i];
                    System.Windows.Rect r;
                    if (!TryGetValidRect(btn, out r)) continue;
                    if (r.Top < bandTop || r.Bottom > bandBottom) continue;
                    if (r.Height < minBtnH || r.Height > maxBtnH) continue;
                    if (r.Left < minBtnLeft) continue;

                    bottomButtonCount++;
                    rowButtons.Add(new KeyValuePair<AutomationElement, System.Windows.Rect>(btn, r));
                    string name = "";
                    try { name = btn.Current.Name ?? ""; } catch { name = ""; }
                    if (string.IsNullOrEmpty(name)) continue;

                    if (modeMatch == null && ContainsAny(name, ModeKeywords) && r.Width >= minModeW && r.Width <= maxModeW)
                    {
                        modeMatch = btn;
                        modeRect = r;
                    }
                    else if (micMatch == null && ContainsAny(name, MicKeywords) && r.Width <= maxIconW)
                    {
                        micMatch = btn;
                        micRect = r;
                    }
                    else if (sendMatch == null && ContainsAny(name, SendStopKeywords) && r.Width <= maxIconW)
                    {
                        sendMatch = btn;
                        sendRect = r;
                    }
                }

                // When narrow pane collapses Turbo into an unlabeled shield icon directly left of Mic, anchor before it
                if (modeMatch == null && micMatch != null)
                {
                    double mcy = (micRect.Top + micRect.Bottom) / 2.0;
                    for (int i = 0; i < rowButtons.Count; i++)
                    {
                        AutomationElement cand = rowButtons[i].Key;
                        if (cand == micMatch) continue;
                        System.Windows.Rect br = rowButtons[i].Value;
                        double bcy = (br.Top + br.Bottom) / 2.0;
                        if (Math.Abs(bcy - mcy) <= 14.0 * dpiScale && br.Right <= micRect.Left + 2.0 * dpiScale && (micRect.Left - br.Right) <= 28.0 * dpiScale && br.Width <= 52.0 * dpiScale)
                        {
                            modeMatch = cand;
                            modeRect = br;
                            break;
                        }
                    }
                }

                AutomationElement chosen = null;
                System.Windows.Rect chosenRect = System.Windows.Rect.Empty;
                int chosenKind = 0;
                int shift = (int)Math.Round(6 * dpiScale);
                if (modeMatch != null) { chosen = modeMatch; chosenRect = modeRect; chosenKind = 1; shift = (int)Math.Round(6 * dpiScale); }
                else if (micMatch != null) { chosen = micMatch; chosenRect = micRect; chosenKind = 2; shift = (int)Math.Round(36 * dpiScale); }
                else if (sendMatch != null) { chosen = sendMatch; chosenRect = sendRect; chosenKind = 3; shift = (int)Math.Round(86 * dpiScale); }

                if (chosen != null)
                {
                    int rX = (int)Math.Round(chosenRect.Left) - shift;
                    double cy = (chosenRect.Top + chosenRect.Bottom) / 2.0;

                    // Locate the nearest button to the LEFT on the same composer toolbar row (e.g. model picker)
                    AutomationElement bestLeft = null;
                    int bestLeftRight = defaultLeftGuard;
                    for (int i = 0; i < rowButtons.Count; i++)
                    {
                        System.Windows.Rect br = rowButtons[i].Value;
                        double bcy = (br.Top + br.Bottom) / 2.0;
                        if (Math.Abs(bcy - cy) > rowAlignTol) continue;
                        if (br.Right >= rX - (int)Math.Round(10 * dpiScale)) continue;
                        int brRight = (int)Math.Round(br.Right) + (int)Math.Round(6 * dpiScale);
                        if (brRight > bestLeftRight)
                        {
                            bestLeftRight = brRight;
                            bestLeft = rowButtons[i].Key;
                        }
                    }

                    cachedAnchor = chosen;
                    cachedKind = chosenKind;
                    cachedLeftGuard = bestLeft;
                    result.HasAnchor = true;
                    result.ComposerVisible = true;
                    result.FromUia = true;
                    result.RightX = rX;
                    result.LeftGuardX = bestLeftRight;
                    result.CenterY = (int)Math.Round(cy);
                    return result;
                }

                // UIA tree is live (>6 buttons in window) but no composer anchor matched: hide instead of drifting
                if (buttons.Count > 6)
                {
                    result.ComposerVisible = false;
                    result.FromUia = true;
                }
            }
            catch { }

            return result;
        }

        private static bool RectsOverlap(double l1, double t1, double r1, double b1, double l2, double t2, double r2, double b2)
        {
            return l1 < r2 && r1 > l2 && t1 < b2 && b1 > t2;
        }

        private static readonly string[] PopupTextMarkers = new string[]
        {
            "weekly limit", "5h limit", "resets in", "% left", "view usage", "claude and gpt", "gemini models"
        };

        private static bool IsElementExpanded(AutomationElement el)
        {
            if (el == null) return false;
            try
            {
                object patObj;
                if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out patObj))
                {
                    var pat = (ExpandCollapsePattern)patObj;
                    return pat.Current.ExpandCollapseState == ExpandCollapseState.Expanded;
                }
            }
            catch { }
            return false;
        }

        private static bool SameElement(AutomationElement a, AutomationElement b)
        {
            if (a == null || b == null) return false;
            try { return Automation.Compare(a, b); }
            catch { return false; }
        }

        private static bool CheckPortalContainerChildren(
            AutomationElement container,
            AutomationElement skipChild,
            int winW,
            int winH,
            int hudLeft,
            int hudTop,
            int hudRight,
            int hudBottom,
            int maxSiblings,
            int descendDepth
        )
        {
            if (container == null) return false;
            try
            {
                AutomationElement child = TreeWalker.ControlViewWalker.GetLastChild(container);
                int count = 0;
                while (child != null && count < maxSiblings)
                {
                    count++;
                    if (!SameElement(child, skipChild))
                    {
                        System.Windows.Rect r;
                        if (TryGetValidRect(child, out r))
                        {
                            bool isFullWin = r.Width >= winW * 0.88 && r.Height >= winH * 0.85;
                            bool isColumn = r.Height >= winH * 0.82;
                            if (!isFullWin && !isColumn && r.Width >= 50 && r.Height >= 30 &&
                                RectsOverlap(r.Left, r.Top, r.Right, r.Bottom, hudLeft - 4, hudTop - 4, hudRight + 4, hudBottom + 4))
                            {
                                return true;
                            }
                            if (descendDepth > 0 && (isFullWin || r.Width >= 50))
                            {
                                if (CheckPortalContainerChildren(child, null, winW, winH, hudLeft, hudTop, hudRight, hudBottom, 6, descendDepth - 1))
                                {
                                    return true;
                                }
                            }
                        }
                        else if (descendDepth > 0)
                        {
                            // Zero-sized portal wrapper (e.g. <div id="portal-root"> or Radix wrapper)
                            if (CheckPortalContainerChildren(child, null, winW, winH, hudLeft, hudTop, hudRight, hudBottom, 6, descendDepth - 1))
                            {
                                return true;
                            }
                        }
                    }
                    child = TreeWalker.ControlViewWalker.GetPreviousSibling(child);
                }
            }
            catch { }
            return false;
        }

        public static bool IsHudOccluded(
            IntPtr hostHwnd,
            IntPtr hudHwnd,
            IntPtr backdropHwnd,
            int selfPid,
            Native.RECT winRect,
            HudAnchorInfo anchor,
            AutomationElement cachedAnchor,
            AutomationElement cachedLeftGuard,
            bool runUiaChecks,
            bool prevOccluded,
            string prevReason,
            out string reason
        )
        {
            reason = "";
            if (!anchor.HasAnchor || !anchor.ComposerVisible) return false;

            double dpiScale = Native.GetWindowDpiScale(hostHwnd);
            int winW = Math.Max(1, winRect.Right - winRect.Left);
            int winH = Math.Max(1, winRect.Bottom - winRect.Top);
            int hudRight = anchor.RightX;
            int hudLeft = Math.Max(anchor.LeftGuardX, hudRight - (int)Math.Round(260 * dpiScale));
            int hudHalfH = (int)Math.Round(13 * dpiScale);
            int hudTop = anchor.CenterY - hudHalfH;
            int hudBottom = anchor.CenterY + hudHalfH;

            // 1. Fast Z-order walk (pure Win32, ~0.05ms): hide if a real higher Win32 window/popup covers the HUD
            try
            {
                IntPtr prev = Native.GetWindow(hostHwnd, Native.GW_HWNDPREV);
                int steps = 0;
                while (prev != IntPtr.Zero && steps < 256)
                {
                    steps++;
                    if (prev != hudHwnd && prev != backdropHwnd && Native.IsWindowVisible(prev) && !Native.IsIconic(prev) && !Native.IsWindowCloaked(prev))
                    {
                        long ex = Native.GetWindowLongPtrCompat(prev, Native.GWL_EXSTYLE);
                        if ((ex & (Native.WS_EX_TRANSPARENT | Native.WS_EX_TOOLWINDOW)) == 0)
                        {
                            uint pid;
                            Native.GetWindowThreadProcessId(prev, out pid);
                            if ((int)pid != selfPid)
                            {
                                Native.RECT pr;
                                if (Native.TryGetVisibleBounds(prev, out pr) &&
                                    (pr.Right - pr.Left) >= 60 && (pr.Bottom - pr.Top) >= 32 &&
                                    RectsOverlap(pr.Left, pr.Top, pr.Right, pr.Bottom, hudLeft, hudTop, hudRight, hudBottom))
                                {
                                    reason = "win32-above";
                                    return true;
                                }
                            }
                        }
                    }
                    prev = Native.GetWindow(prev, Native.GW_HWNDPREV);
                }
            }
            catch { }

            if (!runUiaChecks)
            {
                // Preserve prior UIA popup occlusion state between 260ms probes so HUD never flashes on top of open menus
                if (prevOccluded && !string.Equals(prevReason, "win32-above", StringComparison.Ordinal))
                {
                    reason = prevReason ?? "";
                    return true;
                }
                return false;
            }

            // 2. O(1) ExpandCollapse check on Model picker & Mode picker triggers (~0.05ms):
            // catches "Model" dropdown, "View Usage" submenu, and "Turbo" menu instantly!
            if (IsElementExpanded(cachedLeftGuard) || IsElementExpanded(cachedAnchor))
            {
                reason = "trigger-expanded";
                return true;
            }

            // 3. O(1) React/Radix Portal sibling check (~0.3ms, <=20 nodes, zero FindAll, zero self-flicker):
            // walks up from cachedAnchor to Document, then inspects trailing non-ancestor portal siblings on body/#root.
            if (cachedAnchor != null)
            {
                try
                {
                    var chain = new List<AutomationElement>();
                    AutomationElement cur = cachedAnchor;
                    int docIdx = -1;
                    for (int hop = 0; hop < 28 && cur != null; hop++)
                    {
                        chain.Add(cur);
                        try
                        {
                            if (cur.Current.ControlType == ControlType.Document)
                            {
                                docIdx = hop;
                                break;
                            }
                        }
                        catch { }
                        try { cur = TreeWalker.ControlViewWalker.GetParent(cur); }
                        catch { break; }
                    }

                    if (docIdx >= 1)
                    {
                        // Inspect portals mounted directly on <body> (Document's trailing children)
                        if (CheckPortalContainerChildren(chain[docIdx], chain[docIdx - 1], winW, winH, hudLeft, hudTop, hudRight, hudBottom, 10, 2))
                        {
                            reason = "doc-portal";
                            return true;
                        }
                        // Inspect portals mounted inside #root (first wrapper inside Document)
                        if (docIdx >= 2 && CheckPortalContainerChildren(chain[docIdx - 1], chain[docIdx - 2], winW, winH, hudLeft, hudTop, hudRight, hudBottom, 8, 1))
                        {
                            reason = "root-portal";
                            return true;
                        }
                        // Inspect portals mounted inside top-level app shell
                        if (docIdx >= 3 && CheckPortalContainerChildren(chain[docIdx - 2], chain[docIdx - 3], winW, winH, hudLeft, hudTop, hudRight, hudBottom, 6, 1))
                        {
                            reason = "shell-portal";
                            return true;
                        }
                    }
                }
                catch { }
            }

            // 4. Lightweight FromPoint fallback strictly above HUD for any non-standard overlay
            try
            {
                double probeX = (hudLeft + hudRight) / 2.0;
                double probeY = hudTop - 10.0;
                if (probeX > winRect.Left + 160 && probeX < winRect.Right - 10 && probeY > winRect.Top + 60)
                {
                    AutomationElement hit = AutomationElement.FromPoint(new System.Windows.Point(probeX, probeY));
                    if (hit != null && hit.Current.ProcessId != selfPid)
                    {
                        ControlType ct = hit.Current.ControlType;
                        if (ct == ControlType.MenuItem || ct == ControlType.Menu)
                        {
                            reason = "frompoint-menu";
                            return true;
                        }
                        string hn = hit.Current.Name ?? "";
                        if (ContainsAny(hn, PopupTextMarkers))
                        {
                            reason = "frompoint-marker";
                            return true;
                        }
                    }
                }
            }
            catch { }

            return false;
        }

        public static ActiveViewInfo ProbeActiveConversationView(IntPtr hwnd, Native.RECT winRect)
        {
            var info = new ActiveViewInfo { Workspace = "", Title = "" };
            try
            {
                AutomationElement root = AutomationElement.FromHandle(hwnd);
                if (root == null) return info;

                System.Windows.Automation.Condition cond = new OrCondition(
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text),
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Hyperlink)
                );
                AutomationElementCollection elems = root.FindAll(TreeScope.Descendants, cond);
                if (elems == null || elems.Count == 0) return info;

                // Chat header breadcrumb sits strictly in the top header bar (y ~ Top+26 .. Top+62 logical px), past the left sidebar
                double dpiScale = Native.GetWindowDpiScale(hwnd);
                int headTop = winRect.Top + (int)Math.Round(26 * dpiScale);
                int headBottom = winRect.Top + (int)Math.Round(64 * dpiScale);
                int headMinX = winRect.Left + (int)Math.Round(215 * dpiScale);
                int headMaxX = winRect.Right - (int)Math.Round(90 * dpiScale);
                double maxHeaderItemH = 44.0 * dpiScale;
                double minTextItemW = 36.0 * dpiScale;

                var headerItems = new List<KeyValuePair<double, string>>();
                for (int i = 0; i < elems.Count; i++)
                {
                    AutomationElement el = elems[i];
                    System.Windows.Rect r;
                    if (!TryGetValidRect(el, out r)) continue;
                    if (r.Top < headTop || r.Bottom > headBottom) continue;
                    if (r.Left < headMinX || r.Right > headMaxX) continue;
                    if (r.Height > maxHeaderItemH) continue;

                    string name = "";
                    try { name = (el.Current.Name ?? "").Trim(); } catch { continue; }
                    if (string.IsNullOrEmpty(name)) continue;
                    // Skip compact icon-only toolbar buttons (e.g. "Project options" 24x24 icon)
                    if (name != "/" && r.Width < minTextItemW) continue;

                    // Single-node breadcrumb format: "CastoriceQQbot / 读取指定会话内容"
                    int slashIdx = name.IndexOf(" / ", StringComparison.Ordinal);
                    if (slashIdx > 0 && slashIdx < name.Length - 3)
                    {
                        string ws = name.Substring(0, slashIdx).Trim();
                        string title = name.Substring(slashIdx + 3).Trim();
                        if (!IsHeaderChromeText(title))
                        {
                            info.Workspace = ws;
                            info.Title = title;
                            return info;
                        }
                    }

                    headerItems.Add(new KeyValuePair<double, string>(r.Left, name));
                }

                if (headerItems.Count > 0)
                {
                    headerItems.Sort(delegate(KeyValuePair<double, string> a, KeyValuePair<double, string> b)
                    {
                        return a.Key.CompareTo(b.Key);
                    });

                    // Look for adjacent tokens separated by "/" on the header row
                    for (int i = 0; i < headerItems.Count; i++)
                    {
                        if (headerItems[i].Value == "/" && i + 1 < headerItems.Count)
                        {
                            string ws = i > 0 ? headerItems[i - 1].Value : "";
                            string title = headerItems[i + 1].Value;
                            if (!IsHeaderChromeText(title))
                            {
                                info.Workspace = ws;
                                info.Title = title;
                                return info;
                            }
                        }
                    }

                    // Fallback: first non-chrome title near the left of the chat canvas header
                    int maxHeaderTitleX = winRect.Left + (int)Math.Round(560 * dpiScale);
                    for (int i = 0; i < headerItems.Count; i++)
                    {
                        if (headerItems[i].Key > maxHeaderTitleX) break;
                        string candidate = headerItems[i].Value;
                        if (candidate == "/" || IsHeaderChromeText(candidate)) continue;
                        info.Title = candidate;
                        return info;
                    }
                }
            }
            catch { }

            return info;
        }

        private static bool ActivateElement(AutomationElement el)
        {
            if (el == null) return false;
            try
            {
                object patObj;
                if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out patObj))
                {
                    ((SelectionItemPattern)patObj).Select();
                    return true;
                }
            }
            catch { }
            try
            {
                object patObj;
                if (el.TryGetCurrentPattern(InvokePattern.Pattern, out patObj))
                {
                    ((InvokePattern)patObj).Invoke();
                    return true;
                }
            }
            catch { }
            System.Windows.Rect r;
            if (TryGetValidRect(el, out r))
            {
                Native.SendLeftClickAt((int)Math.Round(r.Left + r.Width / 2.0), (int)Math.Round(r.Top + r.Height / 2.0));
                return true;
            }
            return false;
        }

        private static AutomationElement FindNamedElement(AutomationElement root, string[] keywords, int minY, int maxY, int minX, int maxX)
        {
            try
            {
                System.Windows.Automation.Condition cond = new OrCondition(
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem),
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem),
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem),
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text)
                );
                AutomationElementCollection items = root.FindAll(TreeScope.Descendants, cond);
                if (items == null) return null;

                for (int i = 0; i < items.Count; i++)
                {
                    AutomationElement el = items[i];
                    string name = "";
                    try { name = el.Current.Name ?? ""; } catch { continue; }
                    if (!ContainsAny(name, keywords)) continue;
                    if (ContainsAny(name, WindowChromeExclude)) continue;

                    System.Windows.Rect r;
                    if (!TryGetValidRect(el, out r)) continue;
                    if (r.Top < minY || r.Top > maxY) continue;
                    if (r.Left < minX || r.Left > maxX) continue;
                    return el;
                }
            }
            catch { }
            return null;
        }

        public static string OpenAgyConsolePane(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd)) return "no-window";
            try
            {
                Native.SetForegroundWindow(hwnd);
                Native.RECT winRect;
                if (!Native.TryGetVisibleBounds(hwnd, out winRect)) return "no-bounds";

                AutomationElement root = AutomationElement.FromHandle(hwnd);
                if (root == null) return "no-uia";

                double dpiScale = Native.GetWindowDpiScale(hwnd);
                int tabBandMaxY = winRect.Top + (int)Math.Round(110 * dpiScale);
                int toggleBandMaxY = winRect.Top + (int)Math.Round(72 * dpiScale);
                int toggleMinX = winRect.Right - (int)Math.Round(260 * dpiScale);
                int addTabMinY = winRect.Top + (int)Math.Round(20 * dpiScale);
                int addTabMaxY = winRect.Top + (int)Math.Round(100 * dpiScale);
                int addTabMaxX = winRect.Right - (int)Math.Round(40 * dpiScale);

                string[] consoleNames = new string[] { "agy 控制台", "antigravity monitor" };

                // 1. If AGY 控制台 tab is already open in the top tab strip, activate it directly
                AutomationElement tab = FindNamedElement(
                    root,
                    consoleNames,
                    winRect.Top,
                    tabBandMaxY,
                    winRect.Left,
                    winRect.Right
                );
                if (tab != null && ActivateElement(tab))
                {
                    return "selected-open-tab";
                }

                // 2. Try opening the right auxiliary side pane via top-right toggle button
                AutomationElement toggleBtn = FindNamedElement(
                    root,
                    SidePaneToggleKeywords,
                    winRect.Top,
                    toggleBandMaxY,
                    toggleMinX,
                    winRect.Right
                );
                if (toggleBtn != null && ActivateElement(toggleBtn))
                {
                    Thread.Sleep(260);
                    AutomationElement tabAfter = FindNamedElement(
                        root,
                        consoleNames,
                        winRect.Top,
                        tabBandMaxY,
                        winRect.Left,
                        winRect.Right
                    );
                    if (tabAfter != null && ActivateElement(tabAfter))
                    {
                        return "opened-pane-and-selected";
                    }
                }

                // 3. Fallback: click the "+" (new tab) button in the right half of the tab bar and pick AGY 控制台
                AutomationElement addTabBtn = FindNamedElement(
                    root,
                    new string[] { "new tab", "add tab", "open tab", "open view", "新建标签", "+" },
                    addTabMinY,
                    addTabMaxY,
                    winRect.Left + (winRect.Right - winRect.Left) / 2,
                    addTabMaxX
                );
                if (addTabBtn != null && ActivateElement(addTabBtn))
                {
                    Thread.Sleep(240);
                    AutomationElement menuItem = FindNamedElement(
                        root,
                        consoleNames,
                        winRect.Top,
                        winRect.Bottom,
                        winRect.Left,
                        winRect.Right
                    );
                    if (menuItem != null && ActivateElement(menuItem))
                    {
                        return "opened-via-new-tab";
                    }
                }

                return "tab-not-found";
            }
            catch
            {
                return "error";
            }
        }
    }

    internal sealed class TrackedHostWindow
    {
        public IntPtr Hwnd;
        public long OriginalExStyle;
        public bool OriginallyLayered;
        public bool AlphaApplied;
        public byte LastAlpha = 255;
        public BackdropSurfaceWindow Backdrop;
        public bool BackdropVisible;
        public int LastLeft;
        public int LastTop;
        public int LastWidth;
        public int LastHeight;
        public bool LastMaximized;
        public int AppliedConfigVersion;

        public HudOverlayWindow Hud;
        public bool HudVisible;
        public int LastHudX;
        public int LastHudY;
        public int LastHudW;
        public int LastHudH;
        public double LastHostDpiScale = 1.0;
        public HudAnchorInfo Anchor;
        public int AnchorMissCount;
        public DateTime LastOcclusionCheckUtc = DateTime.MinValue;
        public string LastOccludedReason = "";
        public AutomationElement CachedUiaAnchor;
        public int CachedUiaAnchorKind;
        public AutomationElement CachedLeftGuard;
        public DateTime LastFullUiaScanUtc = DateTime.MinValue;
    }

    internal sealed class CompanionController : IDisposable
    {
        private const string StopEventName = @"Local\AgyMonitorBackdropStop";
        private readonly string _dataDir;
        private readonly string _assetsDir;
        private readonly string _themesPath;
        private readonly string _hudTelemetryPath;
        private readonly string _hudActiveViewPath;
        private readonly string _statusPath;
        private readonly string _lightboxCmdPath;
        private readonly Dispatcher _dispatcher;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();
        private readonly Dictionary<IntPtr, TrackedHostWindow> _tracked = new Dictionary<IntPtr, TrackedHostWindow>();
        private readonly List<IntPtr> _hooks = new List<IntPtr>();
        private Native.WinEventDelegate _winEventDelegate;

        private FileSystemWatcher _watcher;
        private DispatcherTimer _debounceTimer;
        private DispatcherTimer _reconcileTimer;
        private Thread _stopListenerThread;
        private Thread _uiaWorkerThread;
        private EventWaitHandle _stopEvent;
        private readonly AutoResetEvent _uiaWakeEvent = new AutoResetEvent(false);
        private NotifyIcon _trayIcon;
        private Icon _trayIconGlyph;
        private ContextMenuStrip _trayMenu;
        private IntPtr _trayIconHandle = IntPtr.Zero;
        private readonly int _selfPid;
        private ToolStripMenuItem _statusMenuItem;
        private ToolStripMenuItem _pauseMenuItem;
        private ToolStripMenuItem _hudMenuItem;

        private ThemeConfig _config = new ThemeConfig();
        private HudTelemetry _hudTelemetry = new HudTelemetry();
        private string _cachedWpPath = "";
        private DateTime _cachedWpMtimeUtc = DateTime.MinValue;
        private BitmapSource _cachedBitmap = null;
        private DateTime _lastThemesWriteUtc = DateTime.MinValue;
        private long _lastThemesLength = -1;
        private DateTime _lastHudWriteUtc = DateTime.MinValue;
        private long _lastHudLength = -1;
        private DateTime _lastLightboxCmdWriteUtc = DateTime.MinValue;
        private long _lastLightboxCmdLength = -1;
        private string _lastLightboxCmdId = "";
        private ImageLightboxWindow _lightbox = null;
        private IntPtr _lightboxOwnerHwnd = IntPtr.Zero;
        private int _configVersion = 0;
        private DateTime _lastStatusWriteUtc = DateTime.MinValue;
        private DateTime _fastTrackUntilUtc = DateTime.MinValue;
        private DateTime _lastViewProbeUtc = DateTime.MinValue;
        private DateTime _pendingViewProbeAtUtc = DateTime.MaxValue;
        private volatile bool _forceViewProbe = true;
        private string _lastViewKey = "";
        private string _lastViewWorkspace = "";
        private string _lastViewTitle = "";
        private bool _pausedByTray = false;
        private bool _hudEnabledByTray = true;
        private volatile bool _disposed = false;
        private bool _inSync = false;
        private bool _syncPending = false;
        private string _hudLastAction = "";

        public CompanionController(string dataDir, string assetsDir, Dispatcher dispatcher)
        {
            _dataDir = dataDir;
            _assetsDir = assetsDir;
            _themesPath = System.IO.Path.Combine(_dataDir, "themes.json");
            _hudTelemetryPath = System.IO.Path.Combine(_dataDir, "hud_telemetry.json");
            _hudActiveViewPath = System.IO.Path.Combine(_dataDir, "hud_active_view.json");
            _statusPath = System.IO.Path.Combine(_dataDir, "backdrop_status.json");
            _lightboxCmdPath = System.IO.Path.Combine(_dataDir, "lightbox_cmd.json");
            _dispatcher = dispatcher;
            using (Process cur = Process.GetCurrentProcess())
            {
                _selfPid = cur.Id;
            }
        }

        public void Start()
        {
            Directory.CreateDirectory(_dataDir);
            try
            {
                if (File.Exists(_lightboxCmdPath))
                {
                    var fi = new FileInfo(_lightboxCmdPath);
                    _lastLightboxCmdWriteUtc = fi.LastWriteTimeUtc;
                    _lastLightboxCmdLength = fi.Length;
                }
            }
            catch { }
            InitTray();
            ReloadThemeConfig(true);
            ReloadHudTelemetry();
            InstallHooks();
            InstallWatcher();
            StartStopEventListener();
            StartUiaAnchorWorker();

            _debounceTimer = new DispatcherTimer(DispatcherPriority.Render, _dispatcher);
            _debounceTimer.Interval = TimeSpan.FromMilliseconds(16);
            _debounceTimer.Tick += delegate
            {
                _debounceTimer.Stop();
                SyncAllWindows(false);
            };

            int reconcileTick = 0;
            _reconcileTimer = new DispatcherTimer(DispatcherPriority.Background, _dispatcher);
            _reconcileTimer.Interval = TimeSpan.FromMilliseconds(250);
            _reconcileTimer.Tick += delegate
            {
                reconcileTick++;
                CheckDataFilesTimestamp();
                SyncAllWindows((reconcileTick % 4) == 0);
                if ((DateTime.UtcNow - _lastStatusWriteUtc).TotalSeconds >= 2.0)
                {
                    WriteStatusFile(true);
                }
            };
            _reconcileTimer.Start();

            SyncAllWindows(true);
            WriteStatusFile(true);
        }

        private void InitTray()
        {
            using (var bmp = new Bitmap(16, 16))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.Clear(System.Drawing.Color.FromArgb(20, 22, 29));
                    using (var brushA = new SolidBrush(System.Drawing.Color.FromArgb(91, 140, 255)))
                    using (var brushB = new SolidBrush(System.Drawing.Color.FromArgb(61, 194, 167)))
                    {
                        g.FillEllipse(brushA, 2, 2, 12, 12);
                        g.FillEllipse(brushB, 5, 5, 6, 6);
                    }
                }
                _trayIconHandle = bmp.GetHicon();
            }
            _trayIconGlyph = Icon.FromHandle(_trayIconHandle);

            _trayMenu = new ContextMenuStrip();
            var menu = _trayMenu;
            _statusMenuItem = new ToolStripMenuItem("AGY 桌面伴侣");
            _statusMenuItem.Enabled = false;
            menu.Items.Add(_statusMenuItem);
            menu.Items.Add(new ToolStripSeparator());

            _pauseMenuItem = new ToolStripMenuItem("暂停贴背壁纸");
            _pauseMenuItem.Click += delegate
            {
                _dispatcher.BeginInvoke(new Action(delegate
                {
                    _pausedByTray = !_pausedByTray;
                    _pauseMenuItem.Text = _pausedByTray ? "恢复贴背壁纸" : "暂停贴背壁纸";
                    SyncAllWindows(true);
                    WriteStatusFile(true);
                }));
            };
            menu.Items.Add(_pauseMenuItem);

            _hudMenuItem = new ToolStripMenuItem("显示输入框状态胶囊 (HUD)");
            _hudMenuItem.Checked = _hudEnabledByTray;
            _hudMenuItem.Click += delegate
            {
                _dispatcher.BeginInvoke(new Action(delegate
                {
                    _hudEnabledByTray = !_hudEnabledByTray;
                    _hudMenuItem.Checked = _hudEnabledByTray;
                    SyncAllWindows(false);
                    WriteStatusFile(true);
                }));
            };
            menu.Items.Add(_hudMenuItem);

            var reloadItem = new ToolStripMenuItem("立即刷新配置");
            reloadItem.Click += delegate
            {
                _dispatcher.BeginInvoke(new Action(delegate
                {
                    ReloadThemeConfig(true);
                    ReloadHudTelemetry();
                    SyncAllWindows(true);
                    WriteStatusFile(true);
                }));
            };
            menu.Items.Add(reloadItem);

            menu.Items.Add(new ToolStripSeparator());
            var exitItem = new ToolStripMenuItem("退出并还原主窗不透明");
            exitItem.Click += delegate
            {
                _dispatcher.BeginInvoke(new Action(ShutdownGracefully));
            };
            menu.Items.Add(exitItem);

            _trayIcon = new NotifyIcon
            {
                Icon = _trayIconGlyph,
                Text = "AGY 桌面伴侣（壁纸 + 输入框 HUD）",
                ContextMenuStrip = _trayMenu,
                Visible = true
            };
        }

        private void StartStopEventListener()
        {
            _stopEvent = new EventWaitHandle(false, EventResetMode.ManualReset, StopEventName);
            _stopListenerThread = new Thread(delegate()
            {
                try
                {
                    _stopEvent.WaitOne();
                    if (!_disposed)
                    {
                        _dispatcher.BeginInvoke(new Action(ShutdownGracefully));
                    }
                }
                catch { }
            });
            _stopListenerThread.IsBackground = true;
            _stopListenerThread.Start();
        }

        private void TriggerFastUiaBurst(int durationMs, bool probeView)
        {
            DateTime target = DateTime.UtcNow.AddMilliseconds(durationMs);
            if (target > _fastTrackUntilUtc)
            {
                _fastTrackUntilUtc = target;
            }
            if (probeView)
            {
                _forceViewProbe = true;
            }
            try { _uiaWakeEvent.Set(); } catch { }
        }

        private void WriteActiveViewFile(string workspace, string title)
        {
            try
            {
                string ws = (workspace ?? "").Trim();
                string t = (title ?? "").Trim();
                if (string.IsNullOrEmpty(t)) return;
                string key = ws + "|" + t;
                if (string.Equals(key, _lastViewKey, StringComparison.Ordinal)) return;

                // Use a local serializer because WriteActiveViewFile runs on the background UIA worker thread
                var localJson = new JavaScriptSerializer();

                // Protect recent sidecar_focus UUID writes (from clicking a session row in AGY Console)
                // from being clobbered by a stale or title-only UIA header read.
                try
                {
                    if (File.Exists(_hudActiveViewPath))
                    {
                        string existingRaw = ReadTextWithRetry(_hudActiveViewPath);
                        var existingDoc = !string.IsNullOrEmpty(existingRaw)
                            ? (localJson.DeserializeObject(existingRaw) as Dictionary<string, object>)
                            : null;
                        if (existingDoc != null)
                        {
                            string existingSource = ReadString(existingDoc, "source", "");
                            string existingConvId = ReadString(existingDoc, "conversationId", "");
                            string existingTitle = ReadString(existingDoc, "title", "").Trim();
                            long existingTs = ReadLong(existingDoc, "updatedAtMs", 0);
                            long nowMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                            if (string.Equals(existingSource, "sidecar_focus", StringComparison.Ordinal) &&
                                !string.IsNullOrEmpty(existingConvId))
                            {
                                if (existingTs > 0 && (nowMs - existingTs) < 3000)
                                {
                                    return;
                                }
                                if (string.Equals(existingTitle, t, StringComparison.OrdinalIgnoreCase))
                                {
                                    _lastViewKey = key;
                                    _lastViewWorkspace = ws;
                                    _lastViewTitle = t;
                                    return;
                                }
                            }
                        }
                    }
                }
                catch { }

                _lastViewKey = key;
                _lastViewWorkspace = ws;
                _lastViewTitle = t;

                long epochMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                var payload = new Dictionary<string, object>
                {
                    { "workspace", ws },
                    { "title", t },
                    { "source", "uia_header" },
                    { "updatedAtMs", epochMs }
                };
                string tmp = _hudActiveViewPath + ".tmp";
                File.WriteAllText(tmp, localJson.Serialize(payload), Encoding.UTF8);
                try
                {
                    if (File.Exists(_hudActiveViewPath))
                    {
                        File.Replace(tmp, _hudActiveViewPath, null);
                    }
                    else
                    {
                        File.Move(tmp, _hudActiveViewPath);
                    }
                }
                catch
                {
                    File.Copy(tmp, _hudActiveViewPath, true);
                    try { File.Delete(tmp); } catch { }
                }
            }
            catch { }
        }

        private void StartUiaAnchorWorker()
        {
            int selfPid = _selfPid;
            _uiaWorkerThread = new Thread(delegate()
            {
                bool prevMouseDownOnHost = false;
                while (!_disposed)
                {
                    bool mouseDownOnHost = false;
                    bool clickJustReleased = false;
                    try
                    {
                        List<IntPtr> hwnds = new List<IntPtr>();
                        bool cdpTakesHud = false;
                        _dispatcher.Invoke(new Action(delegate
                        {
                            cdpTakesHud = _hudTelemetry != null && _hudTelemetry.cdpHudActive;
                            foreach (TrackedHostWindow item in _tracked.Values)
                            {
                                if (Native.IsWindow(item.Hwnd) && Native.IsWindowVisible(item.Hwnd) && !Native.IsIconic(item.Hwnd))
                                {
                                    hwnds.Add(item.Hwnd);
                                }
                            }
                        }));

                        if (cdpTakesHud || hwnds.Count == 0)
                        {
                            prevMouseDownOnHost = false;
                            try { _uiaWakeEvent.WaitOne(500); } catch { Thread.Sleep(500); }
                            continue;
                        }

                        IntPtr fgHwnd = Native.GetForegroundWindow();
                        bool isFgTracked = fgHwnd != IntPtr.Zero && hwnds.Contains(fgHwnd);
                        bool leftButtonDown = (Native.GetAsyncKeyState(Native.VK_LBUTTON) & 0x8000) != 0;
                        mouseDownOnHost = isFgTracked && leftButtonDown;
                        clickJustReleased = prevMouseDownOnHost && !mouseDownOnHost;

                        if (mouseDownOnHost)
                        {
                            DateTime boost = DateTime.UtcNow.AddMilliseconds(350);
                            if (boost > _fastTrackUntilUtc) _fastTrackUntilUtc = boost;
                        }
                        else if (clickJustReleased)
                        {
                            DateTime postBoost = DateTime.UtcNow.AddMilliseconds(500);
                            if (postBoost > _fastTrackUntilUtc) _fastTrackUntilUtc = postBoost;
                            // Defer breadcrumb probe ~280ms so Electron finishes rendering the newly selected conversation header
                            Native.POINT pt;
                            Native.RECT fgRect;
                            if (Native.GetCursorPos(out pt) && fgHwnd != IntPtr.Zero && Native.TryGetVisibleBounds(fgHwnd, out fgRect))
                            {
                                double fgDpi = Native.GetWindowDpiScale(fgHwnd);
                                if (pt.X < fgRect.Left + (int)Math.Round(360 * fgDpi) || pt.Y < fgRect.Top + (int)Math.Round(110 * fgDpi))
                                {
                                    _pendingViewProbeAtUtc = DateTime.UtcNow.AddMilliseconds(280);
                                }
                            }
                        }
                        prevMouseDownOnHost = mouseDownOnHost;

                        bool pendingDue = DateTime.UtcNow >= _pendingViewProbeAtUtc;
                        bool wantViewProbe = !mouseDownOnHost && (_forceViewProbe || pendingDue || (DateTime.UtcNow - _lastViewProbeUtc).TotalMilliseconds >= 15000);

                        foreach (IntPtr h in hwnds)
                        {
                            if (_disposed) break;
                            Native.RECT winRect;
                            if (!Native.TryGetVisibleBounds(h, out winRect)) continue;

                            AutomationElement cachedEl = null;
                            int cachedKind = 0;
                            AutomationElement cachedLeft = null;
                            DateTime lastScan = DateTime.MinValue;
                            DateTime lastOccCheck = DateTime.MinValue;
                            HudAnchorInfo prevAnchor = new HudAnchorInfo();
                            string prevOccReason = "";
                            int missCount = 0;
                            IntPtr hudHwnd = IntPtr.Zero;
                            IntPtr backdropHwnd = IntPtr.Zero;
                            _dispatcher.Invoke(new Action(delegate
                            {
                                TrackedHostWindow rec;
                                if (_tracked.TryGetValue(h, out rec))
                                {
                                    cachedEl = rec.CachedUiaAnchor;
                                    cachedKind = rec.CachedUiaAnchorKind;
                                    cachedLeft = rec.CachedLeftGuard;
                                    lastScan = rec.LastFullUiaScanUtc;
                                    lastOccCheck = rec.LastOcclusionCheckUtc;
                                    prevAnchor = rec.Anchor;
                                    prevOccReason = rec.LastOccludedReason ?? "";
                                    missCount = rec.AnchorMissCount;
                                    if (rec.Hud != null) hudHwnd = rec.Hud.Handle;
                                    if (rec.Backdrop != null) backdropHwnd = rec.Backdrop.Handle;
                                }
                            }));

                            double rescanCooldownMs = clickJustReleased ? 350.0 : (mouseDownOnHost ? 500.0 : 1200.0);
                            bool canProbeAnchor = cachedEl != null || (DateTime.UtcNow - lastScan).TotalMilliseconds >= rescanCooldownMs;
                            if (canProbeAnchor)
                            {
                                bool hadCached = cachedEl != null;
                                HudAnchorInfo anchor = UiaHelper.ProbeComposerAnchor(h, winRect, ref cachedEl, ref cachedKind, ref cachedLeft);
                                DateTime scanTime = (!hadCached || cachedEl == null) ? DateTime.UtcNow : lastScan;

                                HudAnchorInfo finalAnchor = anchor;
                                int nextMissCount = 0;
                                DateTime nextOccCheck = lastOccCheck;
                                string occReason = "";

                                if (anchor.HasAnchor && anchor.ComposerVisible)
                                {
                                    nextMissCount = 0;
                                    if (mouseDownOnHost)
                                    {
                                        // Never falsely hide during active splitter/window drag
                                        finalAnchor.Occluded = false;
                                    }
                                    else
                                    {
                                        bool runUiaChecks = clickJustReleased || (DateTime.UtcNow - lastOccCheck).TotalMilliseconds >= 260.0;
                                        if (runUiaChecks) nextOccCheck = DateTime.UtcNow;
                                        finalAnchor.Occluded = UiaHelper.IsHudOccluded(h, hudHwnd, backdropHwnd, selfPid, winRect, anchor, cachedEl, cachedLeft, runUiaChecks, prevAnchor.Occluded, prevOccReason, out occReason);
                                    }
                                }
                                else
                                {
                                    nextMissCount = missCount + 1;
                                    // Grace period across transient layout swaps (e.g. Turbo collapsing to shield while dragging sidebar)
                                    if (prevAnchor.HasAnchor && nextMissCount < 4)
                                    {
                                        finalAnchor = prevAnchor;
                                    }
                                }

                                if (!_disposed)
                                {
                                    _dispatcher.BeginInvoke(new Action(delegate
                                    {
                                        TrackedHostWindow rec;
                                        if (!_disposed && _tracked.TryGetValue(h, out rec))
                                        {
                                            rec.CachedUiaAnchor = cachedEl;
                                            rec.CachedUiaAnchorKind = cachedKind;
                                            rec.CachedLeftGuard = cachedLeft;
                                            rec.LastFullUiaScanUtc = scanTime;
                                            rec.LastOcclusionCheckUtc = nextOccCheck;
                                            rec.LastOccludedReason = occReason;
                                            rec.AnchorMissCount = nextMissCount;
                                            rec.Anchor = finalAnchor;
                                            if (_inSync)
                                            {
                                                _syncPending = true;
                                            }
                                            else
                                            {
                                                bool prevInSync = _inSync;
                                                _inSync = true;
                                                try
                                                {
                                                    Native.RECT freshRect;
                                                    if (Native.TryGetVisibleBounds(h, out freshRect))
                                                    {
                                                        SyncHudForWindow(rec, freshRect);
                                                    }
                                                    else
                                                    {
                                                        HideHudIfVisible(rec);
                                                    }
                                                }
                                                finally
                                                {
                                                    _inSync = prevInSync;
                                                    if (_syncPending && !_inSync && !_disposed && _debounceTimer != null && !_debounceTimer.IsEnabled)
                                                    {
                                                        _syncPending = false;
                                                        _debounceTimer.Start();
                                                    }
                                                }
                                            }
                                        }
                                    }));
                                }
                            }

                            // Probe active conversation breadcrumb only on sidebar click / window focus / 15s idle fallback
                            if (wantViewProbe && (h == fgHwnd || hwnds.Count == 1))
                            {
                                _forceViewProbe = false;
                                _pendingViewProbeAtUtc = DateTime.MaxValue;
                                _lastViewProbeUtc = DateTime.UtcNow;
                                ActiveViewInfo view = UiaHelper.ProbeActiveConversationView(h, winRect);
                                if (!string.IsNullOrEmpty(view.Title))
                                {
                                    WriteActiveViewFile(view.Workspace, view.Title);
                                }
                            }
                        }
                    }
                    catch { }

                    int waitMs = mouseDownOnHost ? 33 : (DateTime.UtcNow < _fastTrackUntilUtc ? 85 : 280);
                    try { _uiaWakeEvent.WaitOne(waitMs); } catch { Thread.Sleep(waitMs); }
                }
            });
            _uiaWorkerThread.IsBackground = true;
            _uiaWorkerThread.SetApartmentState(ApartmentState.MTA);
            _uiaWorkerThread.Start();
        }

        private void InstallHooks()
        {
            _winEventDelegate = OnWinEvent;
            uint[] eventsToHook = new uint[]
            {
                Native.EVENT_SYSTEM_FOREGROUND,
                Native.EVENT_SYSTEM_MOVESIZESTART,
                Native.EVENT_SYSTEM_MOVESIZEEND,
                Native.EVENT_SYSTEM_MINIMIZESTART,
                Native.EVENT_SYSTEM_MINIMIZEEND,
                Native.EVENT_OBJECT_LOCATIONCHANGE,
                Native.EVENT_OBJECT_SHOW,
                Native.EVENT_OBJECT_HIDE,
                Native.EVENT_OBJECT_DESTROY
            };
            foreach (uint ev in eventsToHook)
            {
                IntPtr h = Native.SetWinEventHook(ev, ev, IntPtr.Zero, _winEventDelegate, 0, 0, Native.WINEVENT_OUTOFCONTEXT);
                if (h != IntPtr.Zero) _hooks.Add(h);
            }
        }

        private void OnWinEvent(IntPtr hWinEventHook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint dwEventThread, uint dwmsEventTime)
        {
            if (_disposed || hwnd == IntPtr.Zero || idObject != 0) return;

            bool isTracked = _tracked.ContainsKey(hwnd);
            if (eventType == Native.EVENT_SYSTEM_FOREGROUND || isTracked)
            {
                bool probeView = eventType == Native.EVENT_SYSTEM_FOREGROUND || eventType == Native.EVENT_SYSTEM_MOVESIZEEND;
                TriggerFastUiaBurst(500, probeView);
                if (eventType == Native.EVENT_OBJECT_LOCATIONCHANGE && isTracked && !_inSync)
                {
                    SyncAllWindows(false);
                }
                else
                {
                    if (_inSync) _syncPending = true;
                    if (_debounceTimer != null && !_debounceTimer.IsEnabled)
                    {
                        _debounceTimer.Start();
                    }
                }
            }
        }

        private static bool IsTargetFile(string name, string expected)
        {
            return !string.IsNullOrEmpty(name) &&
                string.Equals(System.IO.Path.GetFileName(name), expected, StringComparison.OrdinalIgnoreCase);
        }

        private void InstallWatcher()
        {
            try
            {
                // Watch all files in _dataDir so atomic renames (*.tmp.* -> target.json) are always caught
                _watcher = new FileSystemWatcher(_dataDir, "*");
                _watcher.NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.CreationTime | NotifyFilters.FileName | NotifyFilters.Size;
                _watcher.Changed += OnDataFileEvent;
                _watcher.Created += OnDataFileEvent;
                _watcher.Renamed += delegate(object s, RenamedEventArgs re)
                {
                    HandleDataFileName(re.Name);
                    HandleDataFileName(re.OldName);
                };
                _watcher.EnableRaisingEvents = true;
            }
            catch { }
        }

        private void OnDataFileEvent(object sender, FileSystemEventArgs e)
        {
            if (e != null) HandleDataFileName(e.Name);
        }

        private void HandleDataFileName(string name)
        {
            if (IsTargetFile(name, "themes.json"))
            {
                _dispatcher.BeginInvoke(new Action(delegate
                {
                    if (_disposed) return;
                    ReloadThemeConfig(false);
                    SyncAllWindows(false);
                    WriteStatusFile(true);
                }));
            }
            else if (IsTargetFile(name, "hud_telemetry.json"))
            {
                _dispatcher.BeginInvoke(new Action(delegate
                {
                    if (_disposed) return;
                    ReloadHudTelemetry();
                    PushHudTelemetryToWindows();
                }));
            }
            else if (IsTargetFile(name, "lightbox_cmd.json"))
            {
                _dispatcher.BeginInvoke(new Action(delegate
                {
                    if (_disposed) return;
                    HandleLightboxCommandFile();
                }));
            }
        }

        private void CheckDataFilesTimestamp()
        {
            try
            {
                if (File.Exists(_themesPath))
                {
                    var info = new FileInfo(_themesPath);
                    if (info.LastWriteTimeUtc != _lastThemesWriteUtc || info.Length != _lastThemesLength)
                    {
                        ReloadThemeConfig(false);
                        SyncAllWindows(false);
                        WriteStatusFile(true);
                    }
                }
            }
            catch { }

            try
            {
                if (File.Exists(_hudTelemetryPath))
                {
                    var info = new FileInfo(_hudTelemetryPath);
                    if (info.LastWriteTimeUtc != _lastHudWriteUtc || info.Length != _lastHudLength)
                    {
                        ReloadHudTelemetry();
                        PushHudTelemetryToWindows();
                    }
                }
            }
            catch { }

            try
            {
                if (File.Exists(_lightboxCmdPath))
                {
                    var info = new FileInfo(_lightboxCmdPath);
                    if (info.LastWriteTimeUtc != _lastLightboxCmdWriteUtc || info.Length != _lastLightboxCmdLength)
                    {
                        HandleLightboxCommandFile();
                    }
                }
            }
            catch { }
        }

        private static bool IsAllowedRasterPath(string filePath)
        {
            if (string.IsNullOrEmpty(filePath)) return false;
            string ext = System.IO.Path.GetExtension(filePath);
            if (string.IsNullOrEmpty(ext)) return false;
            ext = ext.ToLowerInvariant();
            return ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".webp" || ext == ".gif" || ext == ".bmp";
        }

        private IntPtr PickTargetHostForLightbox()
        {
            IntPtr fg = Native.GetForegroundWindow();
            if (fg != IntPtr.Zero && _tracked.ContainsKey(fg) && Native.IsWindowVisible(fg) && !Native.IsIconic(fg))
            {
                return fg;
            }
            foreach (TrackedHostWindow item in _tracked.Values)
            {
                if (Native.IsWindow(item.Hwnd) && Native.IsWindowVisible(item.Hwnd) && !Native.IsIconic(item.Hwnd))
                {
                    return item.Hwnd;
                }
            }
            return IntPtr.Zero;
        }

        private void HandleLightboxCommandFile()
        {
            try
            {
                if (!File.Exists(_lightboxCmdPath)) return;
                var info = new FileInfo(_lightboxCmdPath);
                string raw = ReadTextWithRetry(_lightboxCmdPath);
                _lastLightboxCmdWriteUtc = info.LastWriteTimeUtc;
                _lastLightboxCmdLength = info.Length;
                if (string.IsNullOrEmpty(raw)) return;

                var doc = _json.DeserializeObject(raw) as Dictionary<string, object>;
                if (doc == null) return;

                string cmdId = ReadString(doc, "id", "");
                if (!string.IsNullOrEmpty(cmdId) && string.Equals(cmdId, _lastLightboxCmdId, StringComparison.Ordinal))
                {
                    return;
                }

                long tsMs = ReadLong(doc, "ts", 0);
                long nowMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                if (tsMs > 0 && Math.Abs(nowMs - tsMs) > 20000)
                {
                    _lastLightboxCmdId = cmdId;
                    return;
                }

                string imgPath = ReadString(doc, "path", "");
                string label = ReadString(doc, "label", "");
                _lastLightboxCmdId = cmdId;

                if (!IsAllowedRasterPath(imgPath) || !File.Exists(imgPath)) return;
                OpenNativeLightbox(imgPath, label);
            }
            catch { }
        }

        private void OpenNativeLightbox(string imgPath, string label)
        {
            IntPtr ownerHwnd = PickTargetHostForLightbox();
            if (ownerHwnd == IntPtr.Zero) return;

            Native.RECT winRect;
            if (!Native.TryGetVisibleBounds(ownerHwnd, out winRect)) return;

            double dpiScale = Native.GetWindowDpiScale(ownerHwnd);
            bool isMaximized = Native.IsZoomed(ownerHwnd);

            if (_lightbox != null && _lightboxOwnerHwnd != ownerHwnd)
            {
                ImageLightboxWindow oldBox = _lightbox;
                _lightbox = null;
                _lightboxOwnerHwnd = IntPtr.Zero;
                ForceCloseOwnedWindow(oldBox);
            }

            if (_lightbox == null)
            {
                var win = new ImageLightboxWindow(ownerHwnd);
                // Bind BEFORE Show() so re-entrant events or SweepOrphanedWindows always recognize it
                _lightbox = win;
                _lightboxOwnerHwnd = ownerHwnd;
                win.Closed += delegate
                {
                    if (_lightbox == win)
                    {
                        _lightbox = null;
                        _lightboxOwnerHwnd = IntPtr.Zero;
                        if (!_disposed && _debounceTimer != null && !_debounceTimer.IsEnabled)
                        {
                            _debounceTimer.Start();
                        }
                    }
                };
                if (!win.LoadImage(imgPath, label))
                {
                    _lightbox = null;
                    _lightboxOwnerHwnd = IntPtr.Zero;
                    ForceCloseOwnedWindow(win);
                    return;
                }
                win.PositionOverBounds(winRect, dpiScale, isMaximized, _config.radius);
                win.Show();
                win.PositionOverBounds(winRect, dpiScale, isMaximized, _config.radius);
                Native.ForceActivateWindow(win.Handle);
                win.Activate();
                win.Focus();
                Keyboard.Focus(win);
            }
            else
            {
                if (!_lightbox.LoadImage(imgPath, label))
                {
                    return;
                }
                _lightbox.PositionOverBounds(winRect, dpiScale, isMaximized, _config.radius);
                if (!_lightbox.IsVisible) _lightbox.Show();
                Native.ForceActivateWindow(_lightbox.Handle);
                _lightbox.Activate();
                _lightbox.Focus();
                Keyboard.Focus(_lightbox);
            }

            foreach (TrackedHostWindow item in _tracked.Values)
            {
                HideHudIfVisible(item);
            }
        }

        private static string ReadTextWithRetry(string filePath)
        {
            for (int attempt = 0; attempt < 4; attempt++)
            {
                try
                {
                    using (var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    using (var sr = new StreamReader(fs, Encoding.UTF8))
                    {
                        return sr.ReadToEnd();
                    }
                }
                catch (IOException)
                {
                    if (attempt == 3) throw;
                    Thread.Sleep(8);
                }
            }
            return null;
        }

        private void ReloadHudTelemetry()
        {
            try
            {
                if (!File.Exists(_hudTelemetryPath)) return;
                var info = new FileInfo(_hudTelemetryPath);
                string raw = ReadTextWithRetry(_hudTelemetryPath);
                if (string.IsNullOrEmpty(raw)) return;
                _lastHudWriteUtc = info.LastWriteTimeUtc;
                _lastHudLength = info.Length;

                var doc = _json.DeserializeObject(raw) as Dictionary<string, object>;
                if (doc == null) return;

                var next = new HudTelemetry
                {
                    percent = ClampInt(ReadInt(doc, "percent", 0), 0, 100),
                    totalUsed = ReadLong(doc, "totalUsed", 0),
                    windowCap = ReadLong(doc, "windowCap", 512000),
                    tokPerSec = ReadNullableDouble(doc, "tokPerSec"),
                    upstreamModelId = ReadString(doc, "upstreamModelId", ""),
                    upstreamModelStatus = ReadString(doc, "upstreamModelStatus", "no_baseline"),
                    cdpHudActive = ReadBool(doc, "cdpHudActive", false)
                };
                bool cdpChanged = _hudTelemetry == null || _hudTelemetry.cdpHudActive != next.cdpHudActive;
                _hudTelemetry = next;
                if (cdpChanged)
                {
                    SyncAllWindows(false);
                }
            }
            catch { }
        }

        private void PushHudTelemetryToWindows()
        {
            foreach (TrackedHostWindow item in _tracked.Values)
            {
                if (item.Hud != null)
                {
                    item.Hud.UpdateData(_hudTelemetry, _config.accentColor);
                }
            }
        }

        private void ReloadThemeConfig(bool forceImageReload)
        {
            try
            {
                if (!File.Exists(_themesPath)) return;
                var info = new FileInfo(_themesPath);
                string raw = ReadTextWithRetry(_themesPath);
                if (string.IsNullOrEmpty(raw)) return;
                _lastThemesWriteUtc = info.LastWriteTimeUtc;
                _lastThemesLength = info.Length;
                var doc = _json.DeserializeObject(raw) as Dictionary<string, object>;
                if (doc == null) return;

                var next = new ThemeConfig
                {
                    backdropEnabled = ReadBool(doc, "backdropEnabled", true),
                    hudEnabled = ReadBool(doc, "hudEnabled", true),
                    hostThemeMode = ReadString(doc, "hostThemeMode", "backdrop"),
                    hostBlendPct = ClampInt(ReadInt(doc, "hostBlendPct", 18), 5, 42),
                    activeWallpaperId = ReadString(doc, "activeWallpaperId", ""),
                    opacity = ClampInt(ReadInt(doc, "opacity", 32), 0, 100),
                    blur = ClampInt(ReadInt(doc, "blur", 4), 0, 24),
                    dim = ClampInt(ReadInt(doc, "dim", 52), 0, 85),
                    radius = ClampInt(ReadInt(doc, "radius", 12), 4, 18),
                    fit = ReadString(doc, "fit", "cover"),
                    canvasColor = "#070709",
                    accentColor = "#5B8CFF"
                };

                var colors = doc.ContainsKey("colors") ? doc["colors"] as Dictionary<string, object> : null;
                if (colors != null)
                {
                    next.canvasColor = ReadString(colors, "canvas", "#070709");
                    next.accentColor = ReadString(colors, "accent", "#5B8CFF");
                }

                next.wallpaperPath = ResolveWallpaperPath(next.activeWallpaperId, doc);
                _config = next;
                _configVersion++;

                if (forceImageReload || !string.Equals(_cachedWpPath, _config.wallpaperPath ?? "", StringComparison.OrdinalIgnoreCase))
                {
                    LoadSharedWallpaperBitmap(_config.wallpaperPath);
                }
                else if (!string.IsNullOrEmpty(_config.wallpaperPath) && File.Exists(_config.wallpaperPath))
                {
                    DateTime wpTime = File.GetLastWriteTimeUtc(_config.wallpaperPath);
                    if (wpTime != _cachedWpMtimeUtc)
                    {
                        LoadSharedWallpaperBitmap(_config.wallpaperPath);
                    }
                }

                foreach (TrackedHostWindow item in _tracked.Values)
                {
                    if (item.Backdrop != null)
                    {
                        item.AppliedConfigVersion = _configVersion;
                        item.Backdrop.ApplyVisuals(_config, _cachedBitmap, item.LastMaximized);
                    }
                    if (item.Hud != null)
                    {
                        item.Hud.UpdateData(_hudTelemetry, _config.accentColor);
                    }
                }
            }
            catch { }
        }

        private string ResolveWallpaperPath(string activeWpId, Dictionary<string, object> doc)
        {
            if (string.IsNullOrEmpty(activeWpId)) return "";
            if (activeWpId.StartsWith("wp-", StringComparison.OrdinalIgnoreCase))
            {
                string builtinFile = System.IO.Path.Combine(_assetsDir, System.IO.Path.GetFileName(activeWpId) + ".webp");
                return File.Exists(builtinFile) ? builtinFile : "";
            }
            object rawCustomObj;
            if (doc.TryGetValue("customWallpapers", out rawCustomObj) && rawCustomObj is System.Collections.IEnumerable && !(rawCustomObj is string))
            {
                string wpDir = System.IO.Path.Combine(_dataDir, "wallpapers");
                foreach (object entryObj in (System.Collections.IEnumerable)rawCustomObj)
                {
                    var entry = entryObj as Dictionary<string, object>;
                    if (entry == null) continue;
                    string id = ReadString(entry, "id", "");
                    if (string.Equals(id, activeWpId, StringComparison.Ordinal))
                    {
                        string fname = System.IO.Path.GetFileName(ReadString(entry, "filename", ""));
                        if (!string.IsNullOrEmpty(fname))
                        {
                            string full = System.IO.Path.Combine(wpDir, fname);
                            if (File.Exists(full)) return full;
                        }
                    }
                }
            }
            return "";
        }

        private void LoadSharedWallpaperBitmap(string filePath)
        {
            _cachedWpPath = filePath ?? "";
            _cachedBitmap = null;
            _cachedWpMtimeUtc = DateTime.MinValue;
            if (string.IsNullOrEmpty(filePath) || !File.Exists(filePath)) return;

            try
            {
                _cachedWpMtimeUtc = File.GetLastWriteTimeUtc(filePath);
                byte[] bytes = File.ReadAllBytes(filePath);
                using (var ms = new MemoryStream(bytes))
                {
                    var bmp = new BitmapImage();
                    bmp.BeginInit();
                    bmp.CacheOption = BitmapCacheOption.OnLoad;
                    bmp.StreamSource = ms;
                    bmp.EndInit();
                    bmp.Freeze();
                    _cachedBitmap = bmp;
                }
            }
            catch
            {
                _cachedBitmap = null;
            }
        }

        private static void ForceCloseOwnedWindow(Window win)
        {
            if (win == null) return;
            try
            {
                IntPtr h = new WindowInteropHelper(win).Handle;
                if (h != IntPtr.Zero && Native.IsWindow(h))
                {
                    Native.ShowWindow(h, Native.SW_HIDE);
                    Native.SetWindowLongPtrCompat(h, Native.GWLP_HWNDPARENT, 0);
                }
            }
            catch { }
            try { win.Hide(); } catch { }
            try { win.Close(); } catch { }
        }

        private static void HideHudIfVisible(TrackedHostWindow item)
        {
            if (item == null || item.Hud == null) return;
            try
            {
                IntPtr h = item.Hud.Handle;
                if (h != IntPtr.Zero && (item.HudVisible || Native.IsWindowVisible(h)))
                {
                    Native.ShowWindow(h, Native.SW_HIDE);
                }
            }
            catch { }
            item.HudVisible = false;
        }

        private void SweepOrphanedWindows()
        {
            try
            {
                System.Windows.Application app = System.Windows.Application.Current;
                if (app == null) return;

                var active = new HashSet<Window>();
                foreach (TrackedHostWindow item in _tracked.Values)
                {
                    if (item.Hud != null) active.Add(item.Hud);
                    if (item.Backdrop != null) active.Add(item.Backdrop);
                }
                if (_lightbox != null) active.Add(_lightbox);

                var orphans = new List<Window>();
                foreach (Window w in app.Windows)
                {
                    if ((w is HudOverlayWindow || w is BackdropSurfaceWindow || w is ImageLightboxWindow) && !active.Contains(w))
                    {
                        orphans.Add(w);
                    }
                }

                foreach (Window orphan in orphans)
                {
                    ForceCloseOwnedWindow(orphan);
                }
            }
            catch { }
        }

        private void SyncHudForWindow(TrackedHostWindow item, Native.RECT winRect)
        {
            if (item == null || !Native.IsWindow(item.Hwnd)) return;

            bool lightboxOpen = _lightbox != null && _lightbox.IsVisible;
            bool wantHud = _config.hudEnabled && _hudEnabledByTray && !_pausedByTray && !_hudTelemetry.cdpHudActive && !lightboxOpen;
            bool hostVisible = Native.IsWindowVisible(item.Hwnd) && !Native.IsIconic(item.Hwnd) && !Native.IsWindowCloaked(item.Hwnd);
            bool validBounds = (winRect.Right - winRect.Left) >= 300 && (winRect.Bottom - winRect.Top) >= 240;

            // Only show WPF HUD when anchored to a real composer toolbar AND not occluded by native popups (Model/Usage/Dialog)
            bool showHud = wantHud && hostVisible && validBounds && item.Anchor.HasAnchor && item.Anchor.ComposerVisible && !item.Anchor.Occluded;

            if (!showHud)
            {
                HideHudIfVisible(item);
                return;
            }

            if (item.Hud == null)
            {
                IntPtr targetHwnd = item.Hwnd;
                var hud = new HudOverlayWindow(targetHwnd);
                // Bind reference BEFORE Show() so re-entrant WinEvents can never spawn a second orphaned HUD
                item.Hud = hud;
                hud.Clicked += delegate
                {
                    ThreadPool.QueueUserWorkItem(delegate
                    {
                        _hudLastAction = UiaHelper.OpenAgyConsolePane(targetHwnd);
                        _dispatcher.BeginInvoke(new Action(delegate { WriteStatusFile(true); }));
                    });
                };
                hud.UpdateData(_hudTelemetry, _config.accentColor);
                hud.Show();
            }

            IntPtr hudHwnd = item.Hud.Handle;
            if (hudHwnd == IntPtr.Zero) return;

            double hostDpiScale = Native.GetWindowDpiScale(item.Hwnd);
            if (Math.Abs(hostDpiScale - item.LastHostDpiScale) > 0.01)
            {
                item.LastHostDpiScale = hostDpiScale;
                TriggerFastUiaBurst(750, false);
            }

            int physW, physH;
            bool scaleChanged = item.Hud.ApplyDpiScale(hostDpiScale, out physW, out physH);

            int anchorW = Math.Max(1, item.Anchor.AnchorWinRight - item.Anchor.AnchorWinLeft);
            int curW = Math.Max(1, winRect.Right - winRect.Left);
            int relBottom = item.Anchor.AnchorWinBottom - item.Anchor.CenterY;
            int centerY = winRect.Bottom - relBottom;
            int rightX;
            int leftGuardX;

            if (curW == anchorW)
            {
                int dx = winRect.Left - item.Anchor.AnchorWinLeft;
                rightX = item.Anchor.RightX + dx;
                leftGuardX = item.Anchor.LeftGuardX + dx;
            }
            else
            {
                // Instant zero-lag projection while UIA 16ms burst refines exact pixel position
                int relRight = item.Anchor.AnchorWinRight - item.Anchor.RightX;
                rightX = winRect.Right - relRight;
                leftGuardX = winRect.Left + (item.Anchor.LeftGuardX - item.Anchor.AnchorWinLeft);
                TriggerFastUiaBurst(750, false);
            }

            int minRightX = winRect.Left + (int)Math.Round(48 * hostDpiScale);
            int maxRightX = winRect.Right - (int)Math.Round(8 * hostDpiScale);
            if (rightX < minRightX) rightX = minRightX;
            if (rightX > maxRightX) rightX = maxRightX;

            // Never push HUD rightward over Turbo/Voice buttons; instead dynamically trim model width or hide if cramped
            int availPhysW = rightX - leftGuardX - (int)Math.Round(4 * hostDpiScale);
            if (availPhysW < (int)Math.Round(28 * hostDpiScale))
            {
                HideHudIfVisible(item);
                return;
            }
            item.Hud.SetAvailableDipWidth(availPhysW / Math.Max(0.5, hostDpiScale));

            int x = rightX - physW;
            int maxX = winRect.Right - physW - (int)Math.Round(8 * hostDpiScale);
            if (x > maxX) x = maxX;

            int y = centerY - (physH / 2);
            int minY = winRect.Top + (int)Math.Round(60 * hostDpiScale);
            int maxY = Math.Max(minY, winRect.Bottom - physH - (int)Math.Round(6 * hostDpiScale));
            if (y < minY) y = minY;
            if (y > maxY) y = maxY;

            bool moved = scaleChanged || !item.HudVisible || x != item.LastHudX || y != item.LastHudY || physW != item.LastHudW || physH != item.LastHudH;
            if (moved)
            {
                uint flags = Native.SWP_NOACTIVATE | Native.SWP_NOZORDER | Native.SWP_SHOWWINDOW;
                Native.SetWindowPos(hudHwnd, IntPtr.Zero, x, y, physW, physH, flags);
                item.HudVisible = true;
                item.LastHudX = x;
                item.LastHudY = y;
                item.LastHudW = physW;
                item.LastHudH = physH;
            }
        }

        private void SyncAllWindows(bool refreshInventory)
        {
            if (_disposed) return;
            if (_inSync)
            {
                _syncPending = true;
                return;
            }

            _inSync = true;
            try
            {
                if (refreshInventory)
                {
                    List<IntPtr> currentTargets = FindAntigravityTopWindows();
                    var liveSet = new HashSet<IntPtr>(currentTargets);

                    var stale = new List<IntPtr>();
                    foreach (IntPtr existing in _tracked.Keys)
                    {
                        if (!liveSet.Contains(existing) || !Native.IsWindow(existing))
                        {
                            stale.Add(existing);
                        }
                    }
                    foreach (IntPtr h in stale)
                    {
                        RestoreHostWindow(_tracked[h], true);
                        _tracked.Remove(h);
                    }

                    foreach (IntPtr h in currentTargets)
                    {
                        if (!_tracked.ContainsKey(h))
                        {
                            long origEx = Native.GetWindowLongPtrCompat(h, Native.GWL_EXSTYLE);
                            var rec = new TrackedHostWindow
                            {
                                Hwnd = h,
                                OriginalExStyle = origEx,
                                OriginallyLayered = (origEx & Native.WS_EX_LAYERED) != 0
                            };
                            _tracked[h] = rec;
                        }
                    }

                    SweepOrphanedWindows();
                }

                bool isCdpMode = string.Equals(_config.hostThemeMode, "cdp", StringComparison.OrdinalIgnoreCase);
                bool activeEffect = _config.backdropEnabled && !_pausedByTray && _cachedBitmap != null && !isCdpMode;
                byte targetAlpha = activeEffect
                    ? (byte)Math.Max(148, Math.Min(254, Math.Round(255.0 * (100 - _config.hostBlendPct) / 100.0)))
                    : (byte)255;

                foreach (TrackedHostWindow item in _tracked.Values)
                {
                    if (!Native.IsWindow(item.Hwnd))
                    {
                        HideHudIfVisible(item);
                        if (item.Backdrop != null && item.BackdropVisible && item.Backdrop.Handle != IntPtr.Zero)
                        {
                            Native.ShowWindow(item.Backdrop.Handle, Native.SW_HIDE);
                            item.BackdropVisible = false;
                        }
                        continue;
                    }

                    Native.RECT r;
                    bool hasBounds = Native.TryGetVisibleBounds(item.Hwnd, out r);
                    if (hasBounds)
                    {
                        SyncHudForWindow(item, r);
                    }
                    else
                    {
                        HideHudIfVisible(item);
                    }

                    if (!activeEffect)
                    {
                        RestoreBackdropOnly(item, false);
                        continue;
                    }

                    if (!item.AlphaApplied || item.LastAlpha != targetAlpha)
                    {
                        long curEx = Native.GetWindowLongPtrCompat(item.Hwnd, Native.GWL_EXSTYLE);
                        if ((curEx & Native.WS_EX_LAYERED) == 0)
                        {
                            Native.SetWindowLongPtrCompat(item.Hwnd, Native.GWL_EXSTYLE, curEx | Native.WS_EX_LAYERED);
                        }
                        Native.SetLayeredWindowAttributes(item.Hwnd, 0, targetAlpha, Native.LWA_ALPHA);
                        item.AlphaApplied = true;
                        item.LastAlpha = targetAlpha;
                    }

                    bool visible = Native.IsWindowVisible(item.Hwnd) && !Native.IsIconic(item.Hwnd) && !Native.IsWindowCloaked(item.Hwnd);
                    if (!visible)
                    {
                        if (item.Backdrop != null && item.BackdropVisible && item.Backdrop.Handle != IntPtr.Zero)
                        {
                            Native.ShowWindow(item.Backdrop.Handle, Native.SW_HIDE);
                            item.BackdropVisible = false;
                        }
                        continue;
                    }

                    bool isMaximized = Native.IsZoomed(item.Hwnd);
                    if (item.Backdrop == null)
                    {
                        var backdrop = new BackdropSurfaceWindow();
                        item.Backdrop = backdrop;
                        backdrop.Show();
                        item.LastMaximized = isMaximized;
                        item.AppliedConfigVersion = _configVersion;
                        backdrop.ApplyVisuals(_config, _cachedBitmap, isMaximized);
                    }
                    else if (item.LastMaximized != isMaximized || item.AppliedConfigVersion != _configVersion)
                    {
                        item.LastMaximized = isMaximized;
                        item.AppliedConfigVersion = _configVersion;
                        item.Backdrop.ApplyVisuals(_config, _cachedBitmap, isMaximized);
                    }

                    IntPtr wpHwnd = item.Backdrop.Handle;
                    if (wpHwnd == IntPtr.Zero || !hasBounds) continue;

                    int w = Math.Max(1, r.Right - r.Left);
                    int h = Math.Max(1, r.Bottom - r.Top);

                    bool zMismatch = Native.GetWindow(item.Hwnd, Native.GW_HWNDNEXT) != wpHwnd;
                    bool rectChanged = !item.BackdropVisible || r.Left != item.LastLeft || r.Top != item.LastTop || w != item.LastWidth || h != item.LastHeight;

                    if (zMismatch || rectChanged)
                    {
                        uint flags = Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW;
                        Native.SetWindowPos(wpHwnd, item.Hwnd, r.Left, r.Top, w, h, flags);
                        item.BackdropVisible = true;
                        item.LastLeft = r.Left;
                        item.LastTop = r.Top;
                        item.LastWidth = w;
                        item.LastHeight = h;
                    }
                }

                if (_lightbox != null)
                {
                    bool ownerAlive =
                        _lightboxOwnerHwnd != IntPtr.Zero &&
                        Native.IsWindow(_lightboxOwnerHwnd) &&
                        Native.IsWindowVisible(_lightboxOwnerHwnd) &&
                        !Native.IsIconic(_lightboxOwnerHwnd) &&
                        !Native.IsWindowCloaked(_lightboxOwnerHwnd);
                    if (!ownerAlive)
                    {
                        ImageLightboxWindow closingLb = _lightbox;
                        _lightbox = null;
                        _lightboxOwnerHwnd = IntPtr.Zero;
                        ForceCloseOwnedWindow(closingLb);
                    }
                    else
                    {
                        Native.RECT lbRect;
                        if (Native.TryGetVisibleBounds(_lightboxOwnerHwnd, out lbRect))
                        {
                            _lightbox.PositionOverBounds(
                                lbRect,
                                Native.GetWindowDpiScale(_lightboxOwnerHwnd),
                                Native.IsZoomed(_lightboxOwnerHwnd),
                                _config.radius,
                                true
                            );
                        }
                    }
                }

                if (_statusMenuItem != null)
                {
                    string stateDesc = _pausedByTray ? "已暂停" : activeEffect ? "壁纸运行中" : "待机";
                    _statusMenuItem.Text = string.Format("AGY 桌面伴侣 · {0} ({1} 窗)", stateDesc, _tracked.Count);
                }
            }
            finally
            {
                _inSync = false;
                if (_syncPending && !_disposed && _debounceTimer != null && !_debounceTimer.IsEnabled)
                {
                    _syncPending = false;
                    _debounceTimer.Start();
                }
            }
        }

        private List<IntPtr> FindAntigravityTopWindows()
        {
            var found = new List<IntPtr>();
            var cls = new StringBuilder(128);
            var pidCache = new Dictionary<uint, string>();

            Native.EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (!Native.IsWindowVisible(hWnd)) return true;
                if (Native.GetWindow(hWnd, Native.GW_OWNER) != IntPtr.Zero) return true;
                long ex = Native.GetWindowLongPtrCompat(hWnd, Native.GWL_EXSTYLE);
                if ((ex & Native.WS_EX_TOOLWINDOW) != 0) return true;

                cls.Clear();
                Native.GetClassName(hWnd, cls, cls.Capacity);
                if (!string.Equals(cls.ToString(), "Chrome_WidgetWin_1", StringComparison.Ordinal)) return true;

                uint pid;
                Native.GetWindowThreadProcessId(hWnd, out pid);
                string procName;
                if (!pidCache.TryGetValue(pid, out procName))
                {
                    try
                    {
                        using (Process proc = Process.GetProcessById((int)pid))
                        {
                            procName = proc.ProcessName;
                        }
                    }
                    catch { procName = ""; }
                    pidCache[pid] = procName;
                }
                if (!string.Equals(procName, "Antigravity", StringComparison.OrdinalIgnoreCase)) return true;

                // Keep minimized Antigravity windows tracked (their rect is -32000x160x28 while iconic)
                // so minimize/restore hides & reveals overlays cleanly without thrashing WPF windows.
                if (!Native.IsIconic(hWnd))
                {
                    Native.RECT r;
                    if (!Native.GetWindowRect(hWnd, out r)) return true;
                    if ((r.Right - r.Left) < 300 || (r.Bottom - r.Top) < 240) return true;
                }

                found.Add(hWnd);
                return true;
            }, IntPtr.Zero);

            return found;
        }

        private void RestoreBackdropOnly(TrackedHostWindow item, bool closing)
        {
            if (item == null) return;
            if (item.AlphaApplied && Native.IsWindow(item.Hwnd))
            {
                try
                {
                    if (item.OriginallyLayered)
                    {
                        Native.SetLayeredWindowAttributes(item.Hwnd, 0, 255, Native.LWA_ALPHA);
                    }
                    else
                    {
                        long curEx = Native.GetWindowLongPtrCompat(item.Hwnd, Native.GWL_EXSTYLE);
                        Native.SetWindowLongPtrCompat(item.Hwnd, Native.GWL_EXSTYLE, curEx & ~Native.WS_EX_LAYERED);
                        Native.RedrawWindow(item.Hwnd, IntPtr.Zero, IntPtr.Zero, Native.RDW_INVALIDATE | Native.RDW_FRAME | Native.RDW_UPDATENOW);
                    }
                }
                catch { }
            }
            item.AlphaApplied = false;
            item.LastAlpha = 255;

            if (item.Backdrop != null)
            {
                if (closing)
                {
                    BackdropSurfaceWindow closingBackdrop = item.Backdrop;
                    item.Backdrop = null;
                    item.BackdropVisible = false;
                    ForceCloseOwnedWindow(closingBackdrop);
                }
                else if (item.BackdropVisible && item.Backdrop.Handle != IntPtr.Zero)
                {
                    Native.ShowWindow(item.Backdrop.Handle, Native.SW_HIDE);
                    item.BackdropVisible = false;
                }
            }
        }

        private void RestoreHostWindow(TrackedHostWindow item, bool closing)
        {
            if (item == null) return;
            RestoreBackdropOnly(item, closing);
            if (item.Hud != null)
            {
                if (closing)
                {
                    HudOverlayWindow closingHud = item.Hud;
                    item.Hud = null;
                    item.HudVisible = false;
                    ForceCloseOwnedWindow(closingHud);
                }
                else
                {
                    HideHudIfVisible(item);
                }
            }
        }

        private void WriteStatusFile(bool running)
        {
            try
            {
                _lastStatusWriteUtc = DateTime.UtcNow;
                long epochMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                bool isCdpMode = string.Equals(_config.hostThemeMode, "cdp", StringComparison.OrdinalIgnoreCase);
                bool activeEffect = running && _config.backdropEnabled && !_pausedByTray && _cachedBitmap != null && !isCdpMode;
                byte alpha = activeEffect
                    ? (byte)Math.Max(148, Math.Min(254, Math.Round(255.0 * (100 - _config.hostBlendPct) / 100.0)))
                    : (byte)255;

                bool anyHudVisible = false;
                bool anyHudAnchor = false;
                bool anyHudOccluded = false;
                string occReason = "";
                foreach (TrackedHostWindow item in _tracked.Values)
                {
                    if (item.HudVisible) anyHudVisible = true;
                    if (item.Anchor.HasAnchor && item.Anchor.FromUia) anyHudAnchor = true;
                    if (item.Anchor.Occluded)
                    {
                        anyHudOccluded = true;
                        if (!string.IsNullOrEmpty(item.LastOccludedReason)) occReason = item.LastOccludedReason;
                    }
                }

                var payload = new Dictionary<string, object>
                {
                    { "pid", _selfPid },
                    { "running", running },
                    { "activeEffect", activeEffect },
                    { "supportsLightbox", true },
                    { "paused", _pausedByTray },
                    { "trackedCount", _tracked.Count },
                    { "appliedAlpha", alpha },
                    { "hostBlendPct", _config.hostBlendPct },
                    { "activeWallpaperId", _config.activeWallpaperId ?? "" },
                    { "hudEnabled", _config.hudEnabled && _hudEnabledByTray },
                    { "hudVisible", running && anyHudVisible },
                    { "hudAnchorFound", running && anyHudAnchor },
                    { "hudOccluded", running && anyHudOccluded },
                    { "hudOccludedReason", running ? occReason : "" },
                    { "hudActiveWorkspace", _lastViewWorkspace ?? "" },
                    { "hudActiveTitle", _lastViewTitle ?? "" },
                    { "hudLastAction", _hudLastAction ?? "" },
                    { "desktopName", Native.GetDesktopName() },
                    { "updatedAtMs", epochMs }
                };
                string tmp = _statusPath + ".tmp";
                File.WriteAllText(tmp, _json.Serialize(payload), Encoding.UTF8);
                try
                {
                    if (File.Exists(_statusPath))
                    {
                        File.Replace(tmp, _statusPath, null);
                    }
                    else
                    {
                        File.Move(tmp, _statusPath);
                    }
                }
                catch
                {
                    File.Copy(tmp, _statusPath, true);
                    try { File.Delete(tmp); } catch { }
                }
            }
            catch { }
        }

        private void ShutdownGracefully()
        {
            Dispose();
            System.Windows.Application.Current.Shutdown(0);
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            try { if (_debounceTimer != null) _debounceTimer.Stop(); } catch { }
            try { if (_reconcileTimer != null) _reconcileTimer.Stop(); } catch { }
            try { if (_watcher != null) _watcher.Dispose(); } catch { }
            foreach (IntPtr h in _hooks)
            {
                try { Native.UnhookWinEvent(h); } catch { }
            }
            _hooks.Clear();

            foreach (TrackedHostWindow item in _tracked.Values)
            {
                RestoreHostWindow(item, true);
            }
            _tracked.Clear();
            if (_lightbox != null)
            {
                ImageLightboxWindow closingLightbox = _lightbox;
                _lightbox = null;
                _lightboxOwnerHwnd = IntPtr.Zero;
                ForceCloseOwnedWindow(closingLightbox);
            }
            SweepOrphanedWindows();

            WriteStatusFile(false);

            try
            {
                if (_trayIcon != null)
                {
                    _trayIcon.Visible = false;
                    _trayIcon.Icon = null;
                    _trayIcon.ContextMenuStrip = null;
                    _trayIcon.Dispose();
                    _trayIcon = null;
                }
                if (_trayMenu != null)
                {
                    _trayMenu.Dispose();
                    _trayMenu = null;
                }
                if (_trayIconGlyph != null)
                {
                    _trayIconGlyph.Dispose();
                    _trayIconGlyph = null;
                }
                if (_trayIconHandle != IntPtr.Zero)
                {
                    Native.DestroyIcon(_trayIconHandle);
                    _trayIconHandle = IntPtr.Zero;
                }
            }
            catch { }

            try
            {
                if (_stopEvent != null)
                {
                    _stopEvent.Set();
                    _stopEvent.Dispose();
                    _stopEvent = null;
                }
            }
            catch { }

            try
            {
                _uiaWakeEvent.Set();
                _uiaWakeEvent.Dispose();
            }
            catch { }
        }

        private static bool ReadBool(Dictionary<string, object> d, string key, bool fallback)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v is bool) return (bool)v;
            return fallback;
        }

        private static int ReadInt(Dictionary<string, object> d, string key, int fallback)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return fallback;
            try { return Convert.ToInt32(v); } catch { return fallback; }
        }

        private static long ReadLong(Dictionary<string, object> d, string key, long fallback)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return fallback;
            try { return Convert.ToInt64(v); } catch { return fallback; }
        }

        private static double? ReadNullableDouble(Dictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return null;
            try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); } catch { return null; }
        }

        private static string ReadString(Dictionary<string, object> d, string key, string fallback)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v != null) return Convert.ToString(v);
            return fallback;
        }

        private static int ClampInt(int v, int min, int max)
        {
            return Math.Max(min, Math.Min(max, v));
        }

        public static void SignalExistingStop()
        {
            try
            {
                using (var ev = EventWaitHandle.OpenExisting(StopEventName))
                {
                    ev.Set();
                }
            }
            catch { }
        }
    }

    internal static class Program
    {
        [STAThread]
        public static int Main(string[] args)
        {
            Native.EnablePerMonitorDpi();

            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string dataDir = System.IO.Path.Combine(home, ".gemini", "antigravity", "plugin_data", "agy-monitor");
            string assetsDir = System.IO.Path.Combine(home, ".gemini", "config", "plugins", "agy-monitor", "assets", "wallpapers");
            bool stopMode = false;

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--stop") stopMode = true;
                else if (args[i] == "--data-dir" && i + 1 < args.Length) dataDir = args[++i];
                else if (args[i] == "--assets-dir" && i + 1 < args.Length) assetsDir = args[++i];
            }

            if (stopMode)
            {
                CompanionController.SignalExistingStop();
                return 0;
            }

            bool createdNew;
            using (var mutex = new Mutex(true, @"Local\AgyMonitorBackdropSingleton", out createdNew))
            {
                if (!createdNew)
                {
                    return 0;
                }

                var app = new System.Windows.Application
                {
                    ShutdownMode = ShutdownMode.OnExplicitShutdown
                };

                var controller = new CompanionController(dataDir, assetsDir, app.Dispatcher);
                AppDomain.CurrentDomain.ProcessExit += delegate
                {
                    try
                    {
                        if (app.Dispatcher != null && !app.Dispatcher.CheckAccess() && !app.Dispatcher.HasShutdownStarted)
                        {
                            app.Dispatcher.Invoke(DispatcherPriority.Send, TimeSpan.FromSeconds(2), new Action(controller.Dispose));
                        }
                        else
                        {
                            controller.Dispose();
                        }
                    }
                    catch
                    {
                        try { controller.Dispose(); } catch { }
                    }
                };
                app.Exit += delegate { controller.Dispose(); };

                controller.Start();
                app.Run();
                controller.Dispose();
                return 0;
            }
        }
    }
}
