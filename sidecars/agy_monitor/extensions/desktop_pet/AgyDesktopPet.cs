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
using System.Windows.Controls;
using System.Windows.Forms;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace AgyDesktopPetExtension
{
    internal sealed class CustomPetFrameRef
    {
        public string filename = "";
        public string mime = "image/png";
    }

    internal sealed class CustomPetEntry
    {
        public string id = "";
        public string name = "";
        public string kind = "image";
        public int fps = 8;
        public string filename = "";
        public string mime = "image/png";
        public List<CustomPetFrameRef> frames = new List<CustomPetFrameRef>();
        public Dictionary<string, List<CustomPetFrameRef>> stateFrames = new Dictionary<string, List<CustomPetFrameRef>>();
    }

    internal sealed class PetConfig
    {
        public bool enabled = false;
        public string activePetId = "neko";
        public string displayMode = "auto";
        public int size = 100;
        public int opacity = 95;
        public bool alwaysOnTop = true;
        public bool showSpeechBubble = true;
        public string bubbleTemplate = "入 {in} · 出 {out}";
        public bool autoWander = true;
        public bool selectable = true;
        public int? posX = null;
        public int? posY = null;
        public string customImagePath = "";
        public string petsDir = "";
        public CustomPetEntry activeCustomPet = null;
        public List<CustomPetEntry> customPets = new List<CustomPetEntry>();
    }

    internal sealed class PetTelemetry
    {
        public int percent = 0;
        public double? tokPerSec = null;
        public int? cacheHitPct = null;
        public long latestInputTokens = 0;
        public long latestOutputTokens = 0;
        public long latestStepAtMs = 0;
        public string upstreamModelId = "";
        public int activeSessionCount = 0;
        public int unreadSessionCount = 0;
        public string agentState = "idle";
    }

    internal sealed class PetThemePalette
    {
        public string accent = "#5B8CFF";
        public string contrast = "#E5A84B";
        public string tertiary = "#3DC2A7";
        public string canvas = "#14161D";
        public string chrome = "#1B1E28";
        public string bubble = "#212533";
        public int radius = 10;
    }

    internal static class PetNative
    {
        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_TRANSPARENT = 0x00000020;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const int WS_EX_NOACTIVATE = 0x08000000;

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [DllImport("user32.dll")]
        public static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll", EntryPoint = "GetWindowLong")]
        private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")]
        private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
        private static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr")]
        private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        [DllImport("user32.dll")]
        private static extern IntPtr GetThreadDesktop(uint dwThreadId);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpn);

        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr hWnd);

        public static long GetWindowLongPtrCompat(IntPtr hWnd, int nIndex)
        {
            return IntPtr.Size == 8 ? GetWindowLongPtr64(hWnd, nIndex).ToInt64() : GetWindowLong32(hWnd, nIndex);
        }

        public static void SetWindowLongPtrCompat(IntPtr hWnd, int nIndex, long dwNewLong)
        {
            if (IntPtr.Size == 8) SetWindowLongPtr64(hWnd, nIndex, new IntPtr(dwNewLong));
            else SetWindowLong32(hWnd, nIndex, (int)dwNewLong);
        }

        public static double GetWindowDpiScale(IntPtr hWnd)
        {
            try
            {
                if (hWnd != IntPtr.Zero)
                {
                    uint dpi = GetDpiForWindow(hWnd);
                    if (dpi >= 72 && dpi <= 480) return dpi / 96.0;
                }
            }
            catch { }
            return 1.0;
        }

        public static string GetDesktopName()
        {
            try
            {
                var sb = new StringBuilder(128);
                int needed;
                if (GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()), 2, sb, sb.Capacity, out needed))
                {
                    return sb.ToString();
                }
            }
            catch { }
            return "unknown";
        }
    }

    internal sealed class DesktopPetWindow : Window
    {
        private const double BaseStageSize = 112.0;
        private const double BubbleHeightReserve = 44.0;
        private const double BaseWinWidth = 248.0;
        private const double BaseWinHeight = 162.0;

        private readonly Border _bubbleBorder;
        private readonly TextBlock _bubbleText;
        private readonly ScaleTransform _bubbleScale;
        private readonly TranslateTransform _bubbleTranslate;
        private readonly TextBlock _sparkleText;
        private readonly ScaleTransform _sparkleScale;
        private readonly TranslateTransform _sparkleTranslate;
        private readonly Grid _petHost;
        private readonly Canvas _vectorCanvas;
        private readonly System.Windows.Controls.Image _customImage;
        private readonly ScaleTransform _rootScale;
        private readonly ScaleTransform _facingTransform;
        private readonly TranslateTransform _bobTransform;
        private readonly ScaleTransform _squashTransform;
        private readonly RotateTransform _tiltTransform;
        private readonly DispatcherTimer _animTimer;
        private readonly DispatcherTimer _bubbleHideTimer;
        private readonly Stopwatch _animClock = new Stopwatch();
        private long _lastTickMs = 0;
        private int _bubbleAnimGen = 0;
        private string _lastAppliedBubbleTemplate = "";

        private IntPtr _hwnd = IntPtr.Zero;
        private PetConfig _petConfig = new PetConfig();
        private PetTelemetry _telemetry = new PetTelemetry();
        private PetThemePalette _theme = new PetThemePalette();
        private string _accentHex = "#5B8CFF";
        private ThemedPetMenuWindow _activeMenuWindow = null;
        private PetLockBadgeWindow _lockBadgeWindow = null;
        private double _lockBadgeHideGrace = 0.0;
        private double _unlockCelebrationRemaining = 0.0;
        private string _loadedImagePath = "";
        private DateTime _loadedImageMtimeUtc = DateTime.MinValue;
        private readonly List<BitmapSource> _gifFrames = new List<BitmapSource>();
        private readonly List<int> _gifDelaysMs = new List<int>();
        private int _gifFrameIndex = 0;
        private double _gifAccumMs = 0;

        private bool _usingCustomFrames = false;
        private string _loadedFramesSig = "";
        private int _customFramesFps = 8;
        private readonly Dictionary<string, List<BitmapSource>> _customTrackBitmaps = new Dictionary<string, List<BitmapSource>>();
        private string _activeCustomTrack = "idle";
        private int _customFrameIndex = 0;
        private double _customFrameAccumMs = 0;
        private double _interactAnimRemaining = 0.0;

        private RotateTransform _tailRotate;
        private ScaleTransform _eyeLeftScale;
        private ScaleTransform _eyeRightScale;
        private TranslateTransform _floatSubTransform;
        private UIElement _moodBadgeRunning;
        private UIElement _moodBadgeUnread;
        private UIElement _moodBadgeSleep;
        private TextBlock _mechaFaceText;

        private double _phase = 0.0;
        private double _walkPhase = 0.0;
        private double _blinkCountdown = 3.2;
        private double _blinkActive = 0.0;
        private double _hopRemaining = 0.0;
        private double _landBounceRemaining = 0.0;
        private double _tokenBounceRemaining = 0.0;
        private double _bubblePopElapsed = 0.0;
        private double _bubbleTotalDuration = 4.0;
        private double _sparkleElapsed = 99.0;
        private double _sparkleDuration = 1.05;
        private DateTime _lastInteractUtc = DateTime.UtcNow;
        private DateTime _bubbleUntilUtc = DateTime.MinValue;
        private string _lastAutoAgentState = "";
        private string _lastShownTurnSig = "";
        private bool _hasInitialTurnBaseline = false;
        private string _renderedKindKey = "";
        private bool _positionInitialized = false;

        private bool _wandering = false;
        private double _wanderTargetX = 0.0;
        private double _wanderTargetY = 0.0;
        private double _wanderCooldownSec = 7.5;
        private double _wanderFacing = 1.0;

        private bool _dragging = false;
        private bool _dragMoved = false;
        private PetNative.POINT _dragStartCursor;
        private double _dragStartLeft;
        private double _dragStartTop;
        private double _prevDragLeft;
        private double _dragVelX = 0.0;
        private double _dragTiltAngle = 0.0;
        private bool _rightDown = false;
        private bool _rightMoved = false;
        private PetNative.POINT _rightDownCursor;
        private double _menuOpenLeft = 0.0;
        private double _menuOpenTop = 0.0;
        private readonly Random _rng = new Random();

        public event Action<int, int> PositionCommitted;
        public event Action<string> SelectPetRequested;
        public event Action<bool> ToggleBubbleRequested;
        public event Action<bool> ToggleTopmostRequested;
        public event Action<bool> ToggleWanderRequested;
        public event Action<bool> ToggleSelectableRequested;
        public event Action<int> ChangeSizeRequested;
        public event Action ResetPositionRequested;
        public event Action ClosePetRequested;

        public DesktopPetWindow()
        {
            Title = "AGY Desktop Pet";
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            AllowsTransparency = true;
            Background = System.Windows.Media.Brushes.Transparent;
            ShowInTaskbar = false;
            ShowActivated = false;
            Topmost = true;
            Width = BaseWinWidth;
            Height = BaseWinHeight;

            _rootScale = new ScaleTransform(1.0, 1.0);
            _facingTransform = new ScaleTransform(1.0, 1.0);
            _bobTransform = new TranslateTransform(0, 0);
            _squashTransform = new ScaleTransform(1.0, 1.0);
            _tiltTransform = new RotateTransform(0);

            var petTransformGroup = new TransformGroup();
            petTransformGroup.Children.Add(_facingTransform);
            petTransformGroup.Children.Add(_squashTransform);
            petTransformGroup.Children.Add(_tiltTransform);
            petTransformGroup.Children.Add(_bobTransform);

            _bubbleScale = new ScaleTransform(1.0, 1.0);
            _bubbleTranslate = new TranslateTransform(0, 0);
            var bubbleTransformGroup = new TransformGroup();
            bubbleTransformGroup.Children.Add(_bubbleScale);
            bubbleTransformGroup.Children.Add(_bubbleTranslate);

            _sparkleScale = new ScaleTransform(1.0, 1.0);
            _sparkleTranslate = new TranslateTransform(0, 0);
            var sparkleTransformGroup = new TransformGroup();
            sparkleTransformGroup.Children.Add(_sparkleScale);
            sparkleTransformGroup.Children.Add(_sparkleTranslate);

            var rootGrid = new Grid
            {
                Width = BaseWinWidth,
                Height = BaseWinHeight,
                Background = System.Windows.Media.Brushes.Transparent,
                LayoutTransform = _rootScale
            };

            _bubbleText = new TextBlock
            {
                Text = "",
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(242, 244, 250)),
                FontSize = 11.2,
                FontWeight = FontWeights.Medium,
                TextTrimming = TextTrimming.CharacterEllipsis,
                MaxWidth = 228,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                TextAlignment = TextAlignment.Center
            };

            _bubbleBorder = new Border
            {
                Child = _bubbleText,
                Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(228, 22, 25, 36)),
                BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(140, 91, 140, 255)),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(11),
                Padding = new Thickness(10, 4.5, 10, 4.5),
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Top,
                Margin = new Thickness(4, 2, 4, 0),
                Visibility = Visibility.Collapsed,
                IsHitTestVisible = false,
                RenderTransformOrigin = new System.Windows.Point(0.5, 1.0),
                RenderTransform = bubbleTransformGroup,
                CacheMode = new BitmapCache { RenderAtScale = 2.0 },
                Effect = new DropShadowEffect
                {
                    Color = Colors.Black,
                    BlurRadius = 10,
                    ShadowDepth = 2,
                    Opacity = 0.42
                }
            };

            _sparkleText = new TextBlock
            {
                Text = "✨",
                FontSize = 15,
                FontWeight = FontWeights.Bold,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(255, 214, 102)),
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Top,
                Margin = new Thickness(68, 42, 0, 0),
                Visibility = Visibility.Collapsed,
                IsHitTestVisible = false,
                RenderTransformOrigin = new System.Windows.Point(0.5, 0.5),
                RenderTransform = sparkleTransformGroup
            };

            _vectorCanvas = new Canvas
            {
                Width = BaseStageSize,
                Height = BaseStageSize,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };

            _customImage = new System.Windows.Controls.Image
            {
                Width = BaseStageSize - 10,
                Height = BaseStageSize - 10,
                Stretch = Stretch.Uniform,
                Visibility = Visibility.Collapsed
            };
            RenderOptions.SetBitmapScalingMode(_customImage, BitmapScalingMode.HighQuality);

            _petHost = new Grid
            {
                Width = BaseStageSize,
                Height = BaseStageSize,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Bottom,
                Margin = new Thickness(0, BubbleHeightReserve, 0, 4),
                Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(1, 0, 0, 0)),
                RenderTransformOrigin = new System.Windows.Point(0.5, 0.85),
                RenderTransform = petTransformGroup,
                Cursor = System.Windows.Input.Cursors.Hand
            };
            _petHost.Children.Add(_vectorCanvas);
            _petHost.Children.Add(_customImage);

            _petHost.MouseLeftButtonDown += OnPetMouseLeftButtonDown;
            _petHost.MouseMove += OnPetMouseMove;
            _petHost.MouseLeftButtonUp += OnPetMouseLeftButtonUp;
            _petHost.MouseRightButtonDown += OnPetMouseRightButtonDown;
            _petHost.MouseRightButtonUp += OnPetMouseRightButtonUp;

            rootGrid.Children.Add(_petHost);
            rootGrid.Children.Add(_sparkleText);
            rootGrid.Children.Add(_bubbleBorder);
            Content = rootGrid;

            LocationChanged += delegate
            {
                if (_activeMenuWindow != null &&
                    (Math.Abs(Left - _menuOpenLeft) > 1.5 || Math.Abs(Top - _menuOpenTop) > 1.5))
                {
                    CloseActiveMenu();
                }
            };

            SourceInitialized += delegate
            {
                _hwnd = new WindowInteropHelper(this).Handle;
                if (_hwnd != IntPtr.Zero)
                {
                    ApplyWindowSelectability(_petConfig == null || _petConfig.selectable);
                    HwndSource src = HwndSource.FromHwnd(_hwnd);
                    if (src != null) src.AddHook(WndProc);
                }
            };

            _animTimer = new DispatcherTimer(DispatcherPriority.Render, Dispatcher);
            _animTimer.Interval = TimeSpan.FromMilliseconds(16);
            _animTimer.Tick += OnAnimTick;

            _bubbleHideTimer = new DispatcherTimer(DispatcherPriority.Normal, Dispatcher);
            _bubbleHideTimer.Tick += delegate
            {
                _bubbleHideTimer.Stop();
                HideBubbleAnimated();
            };

            Closed += delegate
            {
                try { _animTimer.Stop(); } catch { }
                try { _bubbleHideTimer.Stop(); } catch { }
                CloseActiveMenu();
                CloseLockBadge();
            };
        }

        private void CloseLockBadge()
        {
            if (_lockBadgeWindow != null)
            {
                PetLockBadgeWindow b = _lockBadgeWindow;
                _lockBadgeWindow = null;
                try { b.ForceClose(); } catch { }
            }
        }

        private void CloseActiveMenu()
        {
            if (_activeMenuWindow != null)
            {
                ThemedPetMenuWindow m = _activeMenuWindow;
                _activeMenuWindow = null;
                try { m.Close(); } catch { }
            }
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == 0x0021) // WM_MOUSEACTIVATE
            {
                handled = true;
                return new IntPtr(3); // MA_NOACTIVATE
            }
            return IntPtr.Zero;
        }

        public void SetAnimationRunning(bool run)
        {
            if (run)
            {
                if (!_animTimer.IsEnabled) _animTimer.Start();
            }
            else
            {
                if (_animTimer.IsEnabled) _animTimer.Stop();
            }
        }

        private bool _lastAppliedSelectable = true;

        private void ApplyWindowSelectability(bool selectable)
        {
            _petHost.IsHitTestVisible = selectable;
            if (_hwnd != IntPtr.Zero)
            {
                long ex = PetNative.GetWindowLongPtrCompat(_hwnd, PetNative.GWL_EXSTYLE);
                ex |= PetNative.WS_EX_TOOLWINDOW | PetNative.WS_EX_NOACTIVATE;
                if (selectable) ex &= ~((long)PetNative.WS_EX_TRANSPARENT);
                else ex |= PetNative.WS_EX_TRANSPARENT;
                PetNative.SetWindowLongPtrCompat(_hwnd, PetNative.GWL_EXSTYLE, ex);
            }
            if (!selectable)
            {
                if (_dragging)
                {
                    _dragging = false;
                    try { _petHost.ReleaseMouseCapture(); } catch { }
                }
            }
            if (_lastAppliedSelectable != selectable)
            {
                _lastAppliedSelectable = selectable;
                if (!selectable)
                {
                    _unlockCelebrationRemaining = 0.0;
                    ShowBubble("已锁定鼠标穿透，悬停点击上方锁图标可解锁", 4.6, false);
                }
                else if (_unlockCelebrationRemaining <= 0.0 && _lockBadgeWindow != null)
                {
                    _lockBadgeWindow.FadeOutAndHide();
                }
            }
        }

        public void ApplyConfigAndTelemetry(PetConfig cfg, PetTelemetry telemetry, PetThemePalette theme, bool forcePosition)
        {
            if (cfg != null) _petConfig = cfg;
            if (telemetry != null) _telemetry = telemetry;
            if (theme != null) _theme = theme;
            if (_theme != null && !string.IsNullOrEmpty(_theme.accent)) _accentHex = _theme.accent;

            double scale = Math.Max(0.6, Math.Min(5.0, _petConfig.size / 100.0));
            _rootScale.ScaleX = scale;
            _rootScale.ScaleY = scale;
            Width = Math.Round(BaseWinWidth * scale);
            Height = Math.Round(BaseWinHeight * scale);
            Opacity = Math.Max(0.4, Math.Min(1.0, _petConfig.opacity / 100.0));
            Topmost = _petConfig.alwaysOnTop;
            ApplyWindowSelectability(_petConfig.selectable);

            System.Windows.Media.Color accent = ParseColorOrDefault(_accentHex, System.Windows.Media.Color.FromRgb(91, 140, 255));
            System.Windows.Media.Color bubbleCol = ParseColorOrDefault(_theme != null ? _theme.bubble : "#212533", System.Windows.Media.Color.FromRgb(22, 25, 36));
            bool lightTheme = ((0.299 * bubbleCol.R + 0.587 * bubbleCol.G + 0.114 * bubbleCol.B) / 255.0) >= 0.58;
            _bubbleBorder.Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(236, bubbleCol.R, bubbleCol.G, bubbleCol.B));
            _bubbleBorder.BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(150, accent.R, accent.G, accent.B));
            _bubbleText.Foreground = new SolidColorBrush(lightTheme
                ? System.Windows.Media.Color.FromRgb(24, 28, 38)
                : System.Windows.Media.Color.FromRgb(242, 244, 250));

            bool isCustomFrames = _petConfig.activeCustomPet != null &&
                string.Equals(_petConfig.activeCustomPet.kind, "frames", StringComparison.OrdinalIgnoreCase) &&
                _petConfig.activeCustomPet.frames != null &&
                _petConfig.activeCustomPet.frames.Count > 0 &&
                !string.IsNullOrEmpty(_petConfig.petsDir);
            bool isCustomImage = !isCustomFrames &&
                !string.IsNullOrEmpty(_petConfig.customImagePath) &&
                File.Exists(_petConfig.customImagePath);

            if (isCustomFrames)
            {
                _usingCustomFrames = true;
                LoadCustomFramesIfNeeded(_petConfig.activeCustomPet, _petConfig.petsDir);
                _vectorCanvas.Visibility = Visibility.Collapsed;
                _customImage.Visibility = Visibility.Visible;
                _renderedKindKey = "frames:" + _loadedFramesSig;
            }
            else if (isCustomImage)
            {
                _usingCustomFrames = false;
                LoadCustomImageIfNeeded(_petConfig.customImagePath);
                _vectorCanvas.Visibility = Visibility.Collapsed;
                _customImage.Visibility = Visibility.Visible;
                _renderedKindKey = "custom:" + _petConfig.customImagePath;
            }
            else
            {
                _usingCustomFrames = false;
                _customImage.Visibility = Visibility.Collapsed;
                _vectorCanvas.Visibility = Visibility.Visible;
                string kindKey = (_petConfig.activePetId ?? "neko") + "|" + _accentHex;
                if (!string.Equals(kindKey, _renderedKindKey, StringComparison.Ordinal))
                {
                    RebuildVectorPet(_petConfig.activePetId ?? "neko", accent);
                    _renderedKindKey = kindKey;
                }
            }

            if (forcePosition || !_positionInitialized)
            {
                ApplyInitialOrSavedPosition();
                _positionInitialized = true;
            }

            string curState = ResolveAgentState();
            string curTpl = (_petConfig != null && !string.IsNullOrEmpty(_petConfig.bubbleTemplate))
                ? _petConfig.bubbleTemplate
                : "入 {in} · 出 {out}";
            bool templateChanged = !string.IsNullOrEmpty(_lastAppliedBubbleTemplate) &&
                !string.Equals(curTpl, _lastAppliedBubbleTemplate, StringComparison.Ordinal);
            _lastAppliedBubbleTemplate = curTpl;

            bool hasTokenSample = _telemetry != null && (_telemetry.latestInputTokens > 0 || _telemetry.latestOutputTokens > 0);
            string turnSig = hasTokenSample
                ? string.Format(CultureInfo.InvariantCulture, "{0}|{1}|{2}", _telemetry.latestStepAtMs, _telemetry.latestInputTokens, _telemetry.latestOutputTokens)
                : "";
            bool newTurnArrived = !string.IsNullOrEmpty(turnSig) && !string.Equals(turnSig, _lastShownTurnSig, StringComparison.Ordinal);
            if (templateChanged && _petConfig.showSpeechBubble)
            {
                ShowBubble(RenderBubbleTemplate(curTpl), 5.0, true);
            }
            if (newTurnArrived)
            {
                _lastShownTurnSig = turnSig;
                if (_hasInitialTurnBaseline && _petConfig.showSpeechBubble && !templateChanged)
                {
                    ShowBubble(RenderBubbleTemplate(curTpl), 6.2, true);
                }
                _hasInitialTurnBaseline = true;
            }
            else if (!_hasInitialTurnBaseline)
            {
                _hasInitialTurnBaseline = true;
            }

            if (!string.Equals(curState, _lastAutoAgentState, StringComparison.Ordinal))
            {
                _lastAutoAgentState = curState;
                if (_petConfig.showSpeechBubble && !newTurnArrived && !templateChanged)
                {
                    if (curState == "running")
                    {
                        ShowBubble(RenderBubbleTemplate(curTpl), 4.8, false);
                    }
                    else if (curState == "unread")
                    {
                        _hopRemaining = 0.7;
                        ShowBubble(RenderBubbleTemplate(curTpl), 5.8, true);
                    }
                }
            }
            if (!_petConfig.showSpeechBubble)
            {
                HideBubbleImmediate();
            }
        }

        private string RenderBubbleTemplate(string template)
        {
            string tpl = string.IsNullOrEmpty(template) ? "入 {in} · 出 {out}" : template;
            string inStr = _telemetry != null ? FormatTokenCount(_telemetry.latestInputTokens) : "0";
            string outStr = _telemetry != null ? FormatTokenCount(_telemetry.latestOutputTokens) : "0";
            string tpsStr = (_telemetry != null && _telemetry.tokPerSec.HasValue && _telemetry.tokPerSec.Value > 0)
                ? _telemetry.tokPerSec.Value.ToString("0.0", CultureInfo.InvariantCulture)
                : "--";
            string pctStr = _telemetry != null ? _telemetry.percent.ToString(CultureInfo.InvariantCulture) : "0";
            string modelStr = (_telemetry != null && !string.IsNullOrEmpty(_telemetry.upstreamModelId))
                ? _telemetry.upstreamModelId
                : "待机";
            string cacheStr = (_telemetry != null && _telemetry.cacheHitPct.HasValue)
                ? _telemetry.cacheHitPct.Value.ToString(CultureInfo.InvariantCulture)
                : "--";
            string unreadStr = _telemetry != null ? Math.Max(0, _telemetry.unreadSessionCount).ToString(CultureInfo.InvariantCulture) : "0";

            return tpl
                .Replace("{in}", inStr)
                .Replace("{out}", outStr)
                .Replace("{tps}", tpsStr)
                .Replace("{pct}", pctStr)
                .Replace("{model}", modelStr)
                .Replace("{cache}", cacheStr)
                .Replace("{unread}", unreadStr);
        }

        private static string FormatTokenCount(long count)
        {
            if (count <= 0) return "0";
            if (count < 1000) return count.ToString(CultureInfo.InvariantCulture);
            if (count < 100000)
            {
                double k = count / 1000.0;
                string s = k.ToString("0.0", CultureInfo.InvariantCulture);
                if (s.EndsWith(".0", StringComparison.Ordinal)) s = s.Substring(0, s.Length - 2);
                return s + "k";
            }
            if (count < 1000000)
            {
                return Math.Round(count / 1000.0).ToString("0", CultureInfo.InvariantCulture) + "k";
            }
            double m = count / 1000000.0;
            string ms = m.ToString("0.0", CultureInfo.InvariantCulture);
            if (ms.EndsWith(".0", StringComparison.Ordinal)) ms = ms.Substring(0, ms.Length - 2);
            return ms + "M";
        }

        private string ResolveAgentState()
        {
            if (_telemetry == null) return "idle";
            if (_telemetry.activeSessionCount > 0 || string.Equals(_telemetry.agentState, "running", StringComparison.OrdinalIgnoreCase))
            {
                return "running";
            }
            if (_telemetry.unreadSessionCount > 0 || string.Equals(_telemetry.agentState, "unread", StringComparison.OrdinalIgnoreCase))
            {
                return "unread";
            }
            return "idle";
        }

        private void ApplyInitialOrSavedPosition()
        {
            Rect work = SystemParameters.WorkArea;
            double targetLeft = work.Right - Width - 26.0;
            double targetTop = work.Bottom - Height - 28.0;
            if (_petConfig.posX.HasValue && _petConfig.posY.HasValue)
            {
                targetLeft = _petConfig.posX.Value;
                targetTop = _petConfig.posY.Value;
            }
            double clampedLeft;
            double clampedTop;
            ClampToVirtualScreen(targetLeft, targetTop, out clampedLeft, out clampedTop);
            Left = clampedLeft;
            Top = clampedTop;
        }

        private void ClampToVirtualScreen(double left, double top, out double outLeft, out double outTop)
        {
            double vLeft = SystemParameters.VirtualScreenLeft;
            double vTop = SystemParameters.VirtualScreenTop;
            double vRight = vLeft + SystemParameters.VirtualScreenWidth;
            double vBottom = vTop + SystemParameters.VirtualScreenHeight;
            outLeft = Math.Max(vLeft - Width * 0.25, Math.Min(vRight - Width * 0.75, left));
            outTop = Math.Max(vTop, Math.Min(vBottom - Height * 0.85, top));
        }

        private static BitmapSource LoadSingleFrameBitmap(string imgPath)
        {
            try
            {
                if (string.IsNullOrEmpty(imgPath) || !File.Exists(imgPath)) return null;
                byte[] bytes = File.ReadAllBytes(imgPath);
                using (var ms = new MemoryStream(bytes))
                {
                    var bmp = new BitmapImage();
                    bmp.BeginInit();
                    bmp.CacheOption = BitmapCacheOption.OnLoad;
                    bmp.DecodePixelWidth = 512;
                    bmp.StreamSource = ms;
                    bmp.EndInit();
                    bmp.Freeze();
                    return bmp;
                }
            }
            catch { return null; }
        }

        private void LoadCustomFramesIfNeeded(CustomPetEntry entry, string petsDir)
        {
            if (entry == null || string.IsNullOrEmpty(petsDir)) return;
            _customFramesFps = Math.Max(1, Math.Min(30, entry.fps > 0 ? entry.fps : 8));
            var sb = new StringBuilder();
            sb.Append(entry.id).Append('|').Append(_customFramesFps);
            if (entry.frames != null)
            {
                for (int i = 0; i < entry.frames.Count; i++) sb.Append('|').Append(entry.frames[i].filename);
            }
            if (entry.stateFrames != null)
            {
                string[] tracks = new string[] { "running", "unread", "interact", "walk", "drag" };
                for (int t = 0; t < tracks.Length; t++)
                {
                    List<CustomPetFrameRef> list;
                    if (entry.stateFrames.TryGetValue(tracks[t], out list) && list != null)
                    {
                        sb.Append('#').Append(tracks[t]);
                        for (int i = 0; i < list.Count; i++) sb.Append('|').Append(list[i].filename);
                    }
                }
            }
            string sig = sb.ToString();
            if (string.Equals(sig, _loadedFramesSig, StringComparison.Ordinal) && _customTrackBitmaps.ContainsKey("idle"))
            {
                return;
            }

            _customTrackBitmaps.Clear();
            var idleBitmaps = new List<BitmapSource>();
            if (entry.frames != null)
            {
                for (int i = 0; i < entry.frames.Count; i++)
                {
                    string fname = System.IO.Path.GetFileName(entry.frames[i].filename ?? "");
                    if (string.IsNullOrEmpty(fname)) continue;
                    BitmapSource bmp = LoadSingleFrameBitmap(System.IO.Path.Combine(petsDir, fname));
                    if (bmp != null) idleBitmaps.Add(bmp);
                }
            }
            _customTrackBitmaps["idle"] = idleBitmaps;

            if (entry.stateFrames != null)
            {
                string[] tracks = new string[] { "running", "unread", "interact", "walk", "drag" };
                for (int t = 0; t < tracks.Length; t++)
                {
                    List<CustomPetFrameRef> list;
                    if (!entry.stateFrames.TryGetValue(tracks[t], out list) || list == null || list.Count == 0) continue;
                    var trackBitmaps = new List<BitmapSource>();
                    for (int i = 0; i < list.Count; i++)
                    {
                        string fname = System.IO.Path.GetFileName(list[i].filename ?? "");
                        if (string.IsNullOrEmpty(fname)) continue;
                        BitmapSource bmp = LoadSingleFrameBitmap(System.IO.Path.Combine(petsDir, fname));
                        if (bmp != null) trackBitmaps.Add(bmp);
                    }
                    if (trackBitmaps.Count > 0) _customTrackBitmaps[tracks[t]] = trackBitmaps;
                }
            }

            _loadedFramesSig = sig;
            _activeCustomTrack = "idle";
            _customFrameIndex = 0;
            _customFrameAccumMs = 0;
            if (idleBitmaps.Count > 0) _customImage.Source = idleBitmaps[0];
        }

        private void LoadCustomImageIfNeeded(string imgPath)
        {
            try
            {
                var fi = new FileInfo(imgPath);
                if (string.Equals(_loadedImagePath, imgPath, StringComparison.OrdinalIgnoreCase) &&
                    fi.LastWriteTimeUtc == _loadedImageMtimeUtc &&
                    _customImage.Source != null)
                {
                    return;
                }
                byte[] bytes = File.ReadAllBytes(imgPath);
                _gifFrames.Clear();
                _gifDelaysMs.Clear();
                _gifFrameIndex = 0;
                _gifAccumMs = 0;

                string ext = System.IO.Path.GetExtension(imgPath).ToLowerInvariant();
                if (ext == ".gif")
                {
                    using (var ms = new MemoryStream(bytes))
                    {
                        var decoder = new GifBitmapDecoder(ms, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
                        int maxFrames = Math.Min(decoder.Frames.Count, 90);
                        for (int i = 0; i < maxFrames; i++)
                        {
                            BitmapFrame frame = decoder.Frames[i];
                            frame.Freeze();
                            _gifFrames.Add(frame);
                            int delayMs = 90;
                            try
                            {
                                var meta = frame.Metadata as BitmapMetadata;
                                if (meta != null && meta.ContainsQuery("/grctlext/Delay"))
                                {
                                    int cs = Convert.ToInt32(meta.GetQuery("/grctlext/Delay"), CultureInfo.InvariantCulture);
                                    delayMs = Math.Max(30, Math.Min(2000, cs * 10));
                                }
                            }
                            catch { }
                            _gifDelaysMs.Add(delayMs);
                        }
                    }
                    if (_gifFrames.Count > 0) _customImage.Source = _gifFrames[0];
                }
                else
                {
                    BitmapSource bmp = LoadSingleFrameBitmap(imgPath);
                    if (bmp != null) _customImage.Source = bmp;
                }

                _loadedImagePath = imgPath;
                _loadedImageMtimeUtc = fi.LastWriteTimeUtc;
            }
            catch { }
        }

        private static System.Windows.Media.Color ParseColorOrDefault(string hex, System.Windows.Media.Color fallback)
        {
            try
            {
                if (!string.IsNullOrEmpty(hex))
                {
                    object parsed = System.Windows.Media.ColorConverter.ConvertFromString(hex);
                    if (parsed is System.Windows.Media.Color) return (System.Windows.Media.Color)parsed;
                }
            }
            catch { }
            return fallback;
        }

        private static System.Windows.Shapes.Path MakePath(string data, System.Windows.Media.Brush fill, System.Windows.Media.Brush stroke, double strokeThickness)
        {
            return new System.Windows.Shapes.Path
            {
                Data = Geometry.Parse(data),
                Fill = fill,
                Stroke = stroke,
                StrokeThickness = strokeThickness,
                StrokeLineJoin = PenLineJoin.Round,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round
            };
        }

        private void RebuildVectorPet(string kind, System.Windows.Media.Color accent)
        {
            _vectorCanvas.Children.Clear();
            _tailRotate = null;
            _eyeLeftScale = null;
            _eyeRightScale = null;
            _floatSubTransform = null;
            _moodBadgeRunning = null;
            _moodBadgeUnread = null;
            _moodBadgeSleep = null;
            _mechaFaceText = null;

            var accentBrush = new SolidColorBrush(accent);
            var softGlow = new DropShadowEffect { Color = accent, BlurRadius = 14, ShadowDepth = 0, Opacity = 0.45 };
            var groundShadow = new Ellipse { Width = 64, Height = 12, Fill = new SolidColorBrush(System.Windows.Media.Color.FromArgb(72, 0, 0, 0)) };
            Canvas.SetLeft(groundShadow, 24);
            Canvas.SetTop(groundShadow, 95);
            _vectorCanvas.Children.Add(groundShadow);

            string norm = (kind ?? "neko").Trim().ToLowerInvariant();
            if (norm == "ghost") BuildGhostPet(accent, accentBrush, softGlow);
            else if (norm == "mecha") BuildMechaPet(accent, accentBrush, softGlow);
            else BuildNekoPet(accent, accentBrush, softGlow);

            BuildMoodBadges(accentBrush);
        }

        private void BuildNekoPet(System.Windows.Media.Color accent, SolidColorBrush accentBrush, DropShadowEffect glow)
        {
            var bodyBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(32, 35, 48));
            var outlineBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(200, accent.R, accent.G, accent.B));
            var innerEarBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(236, 134, 166));
            var cheekBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(115, 244, 138, 170));
            var eyeBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(250, 212, 102));

            _tailRotate = new RotateTransform(0, 80, 78);
            var tail = MakePath("M 78,80 C 96,78 103,60 95,48 C 91,42 84,48 88,54 C 92,60 88,70 76,73", null, bodyBrush, 7.5);
            tail.RenderTransform = _tailRotate;
            _vectorCanvas.Children.Add(tail);

            var body = MakePath("M 31,62 C 26,80 31,96 56,96 C 81,96 86,80 81,62 Z", bodyBrush, outlineBrush, 1.6);
            body.Effect = glow;
            _vectorCanvas.Children.Add(body);
            _vectorCanvas.Children.Add(MakePath("M 37,65 Q 56,72 75,65", null, accentBrush, 4.0));
            var bell = new Ellipse { Width = 8, Height = 8, Fill = eyeBrush, Stroke = bodyBrush, StrokeThickness = 1 };
            Canvas.SetLeft(bell, 52); Canvas.SetTop(bell, 66);
            _vectorCanvas.Children.Add(bell);

            _vectorCanvas.Children.Add(MakePath("M 31,42 L 26,18 L 46,31 Z", bodyBrush, outlineBrush, 1.5));
            _vectorCanvas.Children.Add(MakePath("M 81,42 L 86,18 L 66,31 Z", bodyBrush, outlineBrush, 1.5));
            _vectorCanvas.Children.Add(MakePath("M 32,37 L 30,24 L 42,32 Z", innerEarBrush, null, 0));
            _vectorCanvas.Children.Add(MakePath("M 80,37 L 82,24 L 70,32 Z", innerEarBrush, null, 0));

            var head = new Ellipse { Width = 58, Height = 46, Fill = bodyBrush, Stroke = outlineBrush, StrokeThickness = 1.6 };
            Canvas.SetLeft(head, 27); Canvas.SetTop(head, 24);
            _vectorCanvas.Children.Add(head);

            _eyeLeftScale = new ScaleTransform(1, 1, 5.5, 5.5);
            var leftEye = new Ellipse { Width = 11, Height = 11, Fill = eyeBrush, RenderTransform = _eyeLeftScale };
            Canvas.SetLeft(leftEye, 38); Canvas.SetTop(leftEye, 41);
            _vectorCanvas.Children.Add(leftEye);
            var leftSpark = new Ellipse { Width = 3.8, Height = 3.8, Fill = System.Windows.Media.Brushes.White };
            Canvas.SetLeft(leftSpark, 42); Canvas.SetTop(leftSpark, 43);
            _vectorCanvas.Children.Add(leftSpark);

            _eyeRightScale = new ScaleTransform(1, 1, 5.5, 5.5);
            var rightEye = new Ellipse { Width = 11, Height = 11, Fill = eyeBrush, RenderTransform = _eyeRightScale };
            Canvas.SetLeft(rightEye, 63); Canvas.SetTop(rightEye, 41);
            _vectorCanvas.Children.Add(rightEye);
            var rightSpark = new Ellipse { Width = 3.8, Height = 3.8, Fill = System.Windows.Media.Brushes.White };
            Canvas.SetLeft(rightSpark, 67); Canvas.SetTop(rightSpark, 43);
            _vectorCanvas.Children.Add(rightSpark);

            var blushL = new Ellipse { Width = 8, Height = 4.5, Fill = cheekBrush };
            Canvas.SetLeft(blushL, 33); Canvas.SetTop(blushL, 52);
            _vectorCanvas.Children.Add(blushL);
            var blushR = new Ellipse { Width = 8, Height = 4.5, Fill = cheekBrush };
            Canvas.SetLeft(blushR, 71); Canvas.SetTop(blushR, 52);
            _vectorCanvas.Children.Add(blushR);

            _vectorCanvas.Children.Add(MakePath("M 54,51 L 58,51 L 56,53.5 Z", innerEarBrush, null, 0));
            _vectorCanvas.Children.Add(MakePath("M 51,55 Q 53.5,58 56,55 Q 58.5,58 61,55", null, new SolidColorBrush(System.Windows.Media.Color.FromRgb(220, 224, 236)), 1.4));
            _vectorCanvas.Children.Add(MakePath("M 22,47 L 31,48 M 21,52 L 31,52 M 81,48 L 90,47 M 81,52 L 91,52", null, new SolidColorBrush(System.Windows.Media.Color.FromArgb(145, 220, 226, 240)), 1.2));

            var pawL = new Ellipse { Width = 13, Height = 9, Fill = bodyBrush, Stroke = outlineBrush, StrokeThickness = 1.2 };
            Canvas.SetLeft(pawL, 38); Canvas.SetTop(pawL, 88);
            _vectorCanvas.Children.Add(pawL);
            var pawR = new Ellipse { Width = 13, Height = 9, Fill = bodyBrush, Stroke = outlineBrush, StrokeThickness = 1.2 };
            Canvas.SetLeft(pawR, 61); Canvas.SetTop(pawR, 88);
            _vectorCanvas.Children.Add(pawR);
        }

        private void BuildGhostPet(System.Windows.Media.Color accent, SolidColorBrush accentBrush, DropShadowEffect glow)
        {
            _floatSubTransform = new TranslateTransform(0, 0);
            var halo = new Ellipse { Width = 38, Height = 10, Stroke = accentBrush, StrokeThickness = 2.6, RenderTransform = _floatSubTransform };
            Canvas.SetLeft(halo, 37); Canvas.SetTop(halo, 11);
            _vectorCanvas.Children.Add(halo);

            var ghostFill = new LinearGradientBrush(
                System.Windows.Media.Color.FromArgb(245, 240, 246, 255),
                System.Windows.Media.Color.FromArgb(220, (byte)((accent.R + 210) / 2), (byte)((accent.G + 215) / 2), (byte)((accent.B + 235) / 2)),
                90.0);
            var body = MakePath("M 26,56 C 26,28 86,28 86,56 L 86,87 C 81,93 74,84 68,90 C 62,95 56,85 50,90 C 44,95 38,84 32,90 C 28,93 26,89 26,87 Z", ghostFill, accentBrush, 2.0);
            body.Effect = glow;
            _vectorCanvas.Children.Add(body);

            _vectorCanvas.Children.Add(MakePath("M 26,59 Q 17,64 23,71", null, accentBrush, 3.0));
            _vectorCanvas.Children.Add(MakePath("M 86,59 Q 95,64 89,71", null, accentBrush, 3.0));

            var darkEye = new SolidColorBrush(System.Windows.Media.Color.FromRgb(26, 30, 44));
            _eyeLeftScale = new ScaleTransform(1, 1, 5.5, 6.5);
            var eyeL = new Ellipse { Width = 11, Height = 13, Fill = darkEye, RenderTransform = _eyeLeftScale };
            Canvas.SetLeft(eyeL, 40); Canvas.SetTop(eyeL, 45);
            _vectorCanvas.Children.Add(eyeL);
            var sparkL = new Ellipse { Width = 4, Height = 4, Fill = accentBrush };
            Canvas.SetLeft(sparkL, 44); Canvas.SetTop(sparkL, 47);
            _vectorCanvas.Children.Add(sparkL);

            _eyeRightScale = new ScaleTransform(1, 1, 5.5, 6.5);
            var eyeR = new Ellipse { Width = 11, Height = 13, Fill = darkEye, RenderTransform = _eyeRightScale };
            Canvas.SetLeft(eyeR, 61); Canvas.SetTop(eyeR, 45);
            _vectorCanvas.Children.Add(eyeR);
            var sparkR = new Ellipse { Width = 4, Height = 4, Fill = accentBrush };
            Canvas.SetLeft(sparkR, 65); Canvas.SetTop(sparkR, 47);
            _vectorCanvas.Children.Add(sparkR);

            var cheek = new SolidColorBrush(System.Windows.Media.Color.FromArgb(115, 255, 130, 175));
            var cL = new Ellipse { Width = 9, Height = 5, Fill = cheek };
            Canvas.SetLeft(cL, 32); Canvas.SetTop(cL, 58);
            _vectorCanvas.Children.Add(cL);
            var cR = new Ellipse { Width = 9, Height = 5, Fill = cheek };
            Canvas.SetLeft(cR, 71); Canvas.SetTop(cR, 58);
            _vectorCanvas.Children.Add(cR);
            _vectorCanvas.Children.Add(MakePath("M 51,61 Q 56,66 61,61", null, darkEye, 2.0));
        }

        private void BuildMechaPet(System.Windows.Media.Color accent, SolidColorBrush accentBrush, DropShadowEffect glow)
        {
            var shellBrush = new LinearGradientBrush(
                System.Windows.Media.Color.FromRgb(236, 240, 248),
                System.Windows.Media.Color.FromRgb(192, 200, 218),
                90.0);
            var darkTrim = new SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 34, 48));

            _tailRotate = new RotateTransform(0, 56, 26);
            var antenna = MakePath("M 56,26 L 56,14", null, darkTrim, 3.0);
            antenna.RenderTransform = _tailRotate;
            _vectorCanvas.Children.Add(antenna);
            var orb = new Ellipse { Width = 10, Height = 10, Fill = accentBrush, Effect = glow, RenderTransform = _tailRotate };
            Canvas.SetLeft(orb, 51); Canvas.SetTop(orb, 7);
            _vectorCanvas.Children.Add(orb);

            var thruster = new Ellipse { Width = 34, Height = 8, Fill = new SolidColorBrush(System.Windows.Media.Color.FromArgb(145, accent.R, accent.G, accent.B)) };
            Canvas.SetLeft(thruster, 39); Canvas.SetTop(thruster, 89);
            _vectorCanvas.Children.Add(thruster);

            var pod = new System.Windows.Shapes.Rectangle { Width = 44, Height = 24, RadiusX = 11, RadiusY = 11, Fill = shellBrush, Stroke = accentBrush, StrokeThickness = 1.6 };
            Canvas.SetLeft(pod, 34); Canvas.SetTop(pod, 68);
            _vectorCanvas.Children.Add(pod);

            var core = new Ellipse { Width = 9, Height = 9, Fill = accentBrush };
            Canvas.SetLeft(core, 51.5); Canvas.SetTop(core, 75.5);
            _vectorCanvas.Children.Add(core);

            var earL = new System.Windows.Shapes.Rectangle { Width = 8, Height = 20, RadiusX = 4, RadiusY = 4, Fill = accentBrush };
            Canvas.SetLeft(earL, 19); Canvas.SetTop(earL, 38);
            _vectorCanvas.Children.Add(earL);
            var earR = new System.Windows.Shapes.Rectangle { Width = 8, Height = 20, RadiusX = 4, RadiusY = 4, Fill = accentBrush };
            Canvas.SetLeft(earR, 85); Canvas.SetTop(earR, 38);
            _vectorCanvas.Children.Add(earR);

            var helmet = new System.Windows.Shapes.Rectangle { Width = 62, Height = 46, RadiusX = 18, RadiusY = 18, Fill = shellBrush, Stroke = accentBrush, StrokeThickness = 1.8, Effect = glow };
            Canvas.SetLeft(helmet, 25); Canvas.SetTop(helmet, 25);
            _vectorCanvas.Children.Add(helmet);

            var visor = new System.Windows.Shapes.Rectangle { Width = 48, Height = 28, RadiusX = 10, RadiusY = 10, Fill = darkTrim };
            Canvas.SetLeft(visor, 32); Canvas.SetTop(visor, 34);
            _vectorCanvas.Children.Add(visor);

            _mechaFaceText = new TextBlock { Text = "•  •", Width = 48, TextAlignment = TextAlignment.Center, FontSize = 15, FontWeight = FontWeights.Bold, Foreground = accentBrush };
            Canvas.SetLeft(_mechaFaceText, 32); Canvas.SetTop(_mechaFaceText, 37);
            _vectorCanvas.Children.Add(_mechaFaceText);
        }

        private void BuildMoodBadges(SolidColorBrush accentBrush)
        {
            var runTxt = new TextBlock { Text = "⚡", FontSize = 15, Foreground = accentBrush, Visibility = Visibility.Collapsed };
            Canvas.SetLeft(runTxt, 84); Canvas.SetTop(runTxt, 14);
            _vectorCanvas.Children.Add(runTxt);
            _moodBadgeRunning = runTxt;

            var unreadTxt = new TextBlock { Text = "★", FontSize = 16, Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(42, 208, 126)), Visibility = Visibility.Collapsed };
            Canvas.SetLeft(unreadTxt, 84); Canvas.SetTop(unreadTxt, 12);
            _vectorCanvas.Children.Add(unreadTxt);
            _moodBadgeUnread = unreadTxt;

            var sleepTxt = new TextBlock { Text = "Zzz", FontSize = 11, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(System.Windows.Media.Color.FromArgb(200, 185, 195, 225)), Visibility = Visibility.Collapsed };
            Canvas.SetLeft(sleepTxt, 80); Canvas.SetTop(sleepTxt, 12);
            _vectorCanvas.Children.Add(sleepTxt);
            _moodBadgeSleep = sleepTxt;
        }

        private void UpdateAutonomousWander(double dt, string agentState)
        {
            if (!_petConfig.autoWander || _dragging || _activeMenuWindow != null || _hopRemaining > 0 || _interactAnimRemaining > 0 || agentState == "running" || IsMouseOver)
            {
                if (_wandering && (_dragging || _activeMenuWindow != null || agentState == "running"))
                {
                    _wandering = false;
                    _wanderCooldownSec = 5.5 + _rng.NextDouble() * 6.0;
                }
                return;
            }

            if (!_wandering)
            {
                _wanderCooldownSec -= dt;
                if (_wanderCooldownSec > 0) return;

                Rect work = SystemParameters.WorkArea;
                try
                {
                    var pt = new System.Drawing.Point((int)Math.Round(Left + Width * 0.5), (int)Math.Round(Top + Height * 0.5));
                    Screen scr = Screen.FromPoint(pt);
                    if (scr != null)
                    {
                        double dpi = _hwnd != IntPtr.Zero ? PetNative.GetWindowDpiScale(_hwnd) : 1.0;
                        if (dpi <= 0) dpi = 1.0;
                        work = new Rect(scr.WorkingArea.Left / dpi, scr.WorkingArea.Top / dpi, scr.WorkingArea.Width / dpi, scr.WorkingArea.Height / dpi);
                    }
                }
                catch { }

                double minX = work.Left + 8.0;
                double maxX = Math.Max(minX + 40.0, work.Right - Width - 8.0);
                double dist = 110.0 + _rng.NextDouble() * 230.0;
                double dir = _rng.Next(2) == 0 ? -1.0 : 1.0;
                double candX = Left + dir * dist;
                if (candX < minX || candX > maxX)
                {
                    dir = -dir;
                    candX = Math.Max(minX, Math.Min(maxX, Left + dir * dist));
                }
                if (Math.Abs(candX - Left) < 28.0)
                {
                    _wanderCooldownSec = 6.0;
                    return;
                }

                double minY = work.Top + 12.0;
                double maxY = Math.Max(minY + 20.0, work.Bottom - Height - 10.0);
                double candY = Math.Max(minY, Math.Min(maxY, Top + (_rng.NextDouble() - 0.5) * 24.0));

                _wanderTargetX = candX;
                _wanderTargetY = candY;
                _wanderFacing = candX < Left ? -1.0 : 1.0;
                _wandering = true;
                return;
            }

            double dx = _wanderTargetX - Left;
            double dy = _wanderTargetY - Top;
            double rem = Math.Sqrt(dx * dx + dy * dy);
            const double walkSpeedPxPerSec = 66.0;
            double step = walkSpeedPxPerSec * dt;
            if (rem <= step + 1.5)
            {
                Left = Math.Round(_wanderTargetX);
                Top = Math.Round(_wanderTargetY);
                _wandering = false;
                _wanderCooldownSec = 8.0 + _rng.NextDouble() * 10.0;
                Action<int, int> handler = PositionCommitted;
                if (handler != null) handler((int)Math.Round(Left), (int)Math.Round(Top));
            }
            else
            {
                _wanderFacing = dx < 0 ? -1.0 : 1.0;
                Left += (dx / rem) * step;
                Top += (dy / rem) * step;
                _walkPhase += dt * 13.5;
            }
        }

        private void TriggerSparkle(string symbol)
        {
            if (_sparkleText == null) return;
            _sparkleText.Text = string.IsNullOrEmpty(symbol) ? "✨" : symbol;
            _sparkleElapsed = 0.0;
            _sparkleDuration = 1.05;
            _sparkleText.Visibility = Visibility.Visible;
            _sparkleText.Opacity = 1.0;
            _sparkleTranslate.Y = 0;
            _sparkleScale.ScaleX = 0.7;
            _sparkleScale.ScaleY = 0.7;
        }

        private void UpdateLockBadge(double dt)
        {
            if (_unlockCelebrationRemaining > 0.0)
            {
                _unlockCelebrationRemaining = Math.Max(0.0, _unlockCelebrationRemaining - dt);
                if (_lockBadgeWindow != null)
                {
                    PositionLockBadge(_lockBadgeWindow);
                    if (_unlockCelebrationRemaining <= 0.0)
                    {
                        _lockBadgeWindow.FadeOutAndHide();
                    }
                }
                return;
            }

            if (_petConfig == null || _petConfig.selectable)
            {
                if (_lockBadgeWindow != null && _lockBadgeWindow.IsShowing)
                {
                    _lockBadgeWindow.FadeOutAndHide();
                }
                return;
            }

            PetNative.POINT curPx;
            if (!PetNative.GetCursorPos(out curPx)) return;
            double dpi = _hwnd != IntPtr.Zero ? PetNative.GetWindowDpiScale(_hwnd) : 1.0;
            if (dpi <= 0) dpi = 1.0;
            double cx = curPx.X / dpi;
            double cy = curPx.Y / dpi;

            double scale = Math.Max(0.6, Math.Min(5.0, _petConfig.size / 100.0));
            double stageW = BaseStageSize * scale;
            double stageH = BaseStageSize * scale;
            double petLeft = Left + (Width - stageW) * 0.5;
            double petTop = Top + BubbleHeightReserve * scale;
            double petRight = petLeft + stageW;
            double petBottom = petTop + stageH;

            double badgeLeft;
            double badgeTop;
            ComputeLockBadgeAnchor(out badgeLeft, out badgeTop);

            bool overPet = (cx >= petLeft && cx <= petRight && cy >= petTop && cy <= petBottom);
            bool overBadgeOrBridge =
                (_lockBadgeWindow != null && _lockBadgeWindow.IsShowing) &&
                (cx >= badgeLeft - 10 && cx <= badgeLeft + 64 && cy >= badgeTop - 6 && cy <= petTop + 14);

            if (overPet || overBadgeOrBridge)
            {
                _lockBadgeHideGrace = 0.28;
                if (_lockBadgeWindow == null)
                {
                    var badge = new PetLockBadgeWindow(_theme, delegate
                    {
                        _unlockCelebrationRemaining = 0.72;
                        _petConfig.selectable = true;
                        ApplyWindowSelectability(true);
                        TriggerSparkle("🔓");
                        ShowBubble("已解锁桌宠，现在可以自由拖动了 ✨", 3.6, false);
                        Action<bool> h = ToggleSelectableRequested;
                        if (h != null) h(true);
                    });
                    _lockBadgeWindow = badge;
                }
                _lockBadgeWindow.ApplyTheme(_theme, _petConfig.alwaysOnTop);
                PositionLockBadge(_lockBadgeWindow);
                _lockBadgeWindow.ShowLocked();
            }
            else if (_lockBadgeWindow != null && _lockBadgeWindow.IsShowing)
            {
                _lockBadgeHideGrace -= dt;
                if (_lockBadgeHideGrace <= 0.0)
                {
                    _lockBadgeWindow.FadeOutAndHide();
                }
            }
        }

        private void ComputeLockBadgeAnchor(out double badgeLeft, out double badgeTop)
        {
            double scale = Math.Max(0.6, Math.Min(5.0, _petConfig.size / 100.0));
            badgeLeft = Left + (Width - 54.0) * 0.5;
            badgeTop = Top + BubbleHeightReserve * scale - 46.0;
            double minTop = SystemParameters.VirtualScreenTop + 2.0;
            if (badgeTop < minTop) badgeTop = minTop;
        }

        private void PositionLockBadge(PetLockBadgeWindow badge)
        {
            if (badge == null) return;
            double bx;
            double by;
            ComputeLockBadgeAnchor(out bx, out by);
            badge.Left = Math.Round(bx);
            badge.Top = Math.Round(by);
        }

        private void OnAnimTick(object sender, EventArgs e)
        {
            if (Visibility != Visibility.Visible) return;
            if (!_animClock.IsRunning)
            {
                _animClock.Start();
                _lastTickMs = 0;
            }
            long nowMs = _animClock.ElapsedMilliseconds;
            double dt = (_lastTickMs > 0) ? ((nowMs - _lastTickMs) / 1000.0) : 0.016;
            _lastTickMs = nowMs;
            if (dt < 0.004) dt = 0.004;
            if (dt > 0.05) dt = 0.05;
            double dtMs = dt * 1000.0;

            string agentState = ResolveAgentState();
            bool sleepy = agentState == "idle" && !_wandering && !_dragging && (DateTime.UtcNow - _lastInteractUtc).TotalSeconds > 45.0;

            UpdateLockBadge(dt);
            UpdateAutonomousWander(dt, agentState);

            double speedMult = agentState == "running" ? 2.1 : (agentState == "unread" ? 1.5 : (sleepy ? 0.55 : 1.0));
            _phase += dt * 2.6 * speedMult;

            if (_customImage.Visibility == Visibility.Visible && _usingCustomFrames)
            {
                if (_interactAnimRemaining > 0) _interactAnimRemaining = Math.Max(0.0, _interactAnimRemaining - dt);
                string desiredTrack = "idle";
                if (_dragging && _customTrackBitmaps.ContainsKey("drag")) desiredTrack = "drag";
                else if (_interactAnimRemaining > 0 && _customTrackBitmaps.ContainsKey("interact")) desiredTrack = "interact";
                else if (_wandering && _customTrackBitmaps.ContainsKey("walk")) desiredTrack = "walk";
                else if (agentState == "running" && _customTrackBitmaps.ContainsKey("running")) desiredTrack = "running";
                else if (agentState == "unread" && _customTrackBitmaps.ContainsKey("unread")) desiredTrack = "unread";

                List<BitmapSource> trackFrames;
                if (!_customTrackBitmaps.TryGetValue(desiredTrack, out trackFrames) || trackFrames == null || trackFrames.Count == 0)
                {
                    _customTrackBitmaps.TryGetValue("idle", out trackFrames);
                    desiredTrack = "idle";
                }
                if (trackFrames != null && trackFrames.Count > 0)
                {
                    if (!string.Equals(desiredTrack, _activeCustomTrack, StringComparison.Ordinal))
                    {
                        _activeCustomTrack = desiredTrack;
                        _customFrameIndex = 0;
                        _customFrameAccumMs = 0;
                        _customImage.Source = trackFrames[0];
                    }
                    else if (trackFrames.Count > 1)
                    {
                        double frameIntervalMs = 1000.0 / Math.Max(1, _customFramesFps);
                        _customFrameAccumMs += dtMs;
                        if (_customFrameAccumMs >= frameIntervalMs)
                        {
                            _customFrameAccumMs %= frameIntervalMs;
                            _customFrameIndex = (_customFrameIndex + 1) % trackFrames.Count;
                            _customImage.Source = trackFrames[_customFrameIndex];
                        }
                    }
                }
            }
            else if (_customImage.Visibility == Visibility.Visible && _gifFrames.Count > 1)
            {
                _gifAccumMs += dtMs;
                int curDelay = (_gifFrameIndex < _gifDelaysMs.Count) ? _gifDelaysMs[_gifFrameIndex] : 90;
                if (_gifAccumMs >= curDelay)
                {
                    _gifAccumMs -= curDelay;
                    _gifFrameIndex = (_gifFrameIndex + 1) % _gifFrames.Count;
                    _customImage.Source = _gifFrames[_gifFrameIndex];
                }
            }

            // Smooth facing flip when autonomously strolling left/right
            double targetFacing = _wandering ? _wanderFacing : 1.0;
            _facingTransform.ScaleX = targetFacing;

            double hopY = 0.0;
            double squashX = 1.0;
            double squashY = 1.0;
            double extraTilt = 0.0;

            if (_dragging)
            {
                // Spring pendulum dangle physics while dragging
                double targetAngle = Math.Max(-24.0, Math.Min(24.0, -_dragVelX * 1.45));
                _dragTiltAngle += (targetAngle - _dragTiltAngle) * 0.28;
                _dragVelX *= 0.72;
                squashX = 0.94;
                squashY = 1.08;
                hopY = -4.0 + Math.Sin(_phase * 2.2) * 1.8;
            }
            else
            {
                _dragTiltAngle *= 0.74;
                if (_hopRemaining > 0)
                {
                    _hopRemaining = Math.Max(0, _hopRemaining - dt);
                    double p = Math.Max(0.0, Math.Min(1.0, 1.0 - (_hopRemaining / 0.58)));
                    hopY = -Math.Abs(Math.Sin(p * Math.PI * 2.0)) * 13.5;
                    squashX = 1.0 + Math.Sin(p * Math.PI * 2.0) * 0.09;
                    squashY = 1.0 - Math.Sin(p * Math.PI * 2.0) * 0.08;
                    extraTilt = Math.Sin(p * Math.PI * 3.0) * 5.5;
                }
                else if (_landBounceRemaining > 0)
                {
                    _landBounceRemaining = Math.Max(0, _landBounceRemaining - dt);
                    double p = Math.Max(0.0, Math.Min(1.0, 1.0 - (_landBounceRemaining / 0.42)));
                    double damp = Math.Sin(p * Math.PI * 2.0) * (1.0 - p);
                    squashX = 1.0 + damp * 0.16;
                    squashY = 1.0 - damp * 0.14;
                    hopY = Math.Max(0.0, damp * 4.0);
                }
                else if (_tokenBounceRemaining > 0)
                {
                    _tokenBounceRemaining = Math.Max(0, _tokenBounceRemaining - dt);
                    double p = Math.Max(0.0, Math.Min(1.0, 1.0 - (_tokenBounceRemaining / 0.36)));
                    double wave = Math.Sin(p * Math.PI);
                    hopY = -wave * 7.5;
                    squashX = 1.0 - wave * 0.05;
                    squashY = 1.0 + wave * 0.06;
                }
                else if (_wandering)
                {
                    hopY = -Math.Abs(Math.Sin(_walkPhase)) * 5.5;
                    squashX = 1.0 + Math.Sin(_walkPhase * 2.0) * 0.03;
                    squashY = 1.0 - Math.Sin(_walkPhase * 2.0) * 0.03;
                    extraTilt = Math.Sin(_walkPhase) * 4.2;
                }
            }

            double bobAmp = _dragging || _wandering ? 0.0 : (agentState == "running" ? 2.6 : (sleepy ? 1.5 : 3.2));
            _bobTransform.Y = Math.Sin(_phase) * bobAmp + hopY;
            _squashTransform.ScaleX = squashX;
            _squashTransform.ScaleY = squashY;
            _tiltTransform.Angle = _dragging
                ? _dragTiltAngle
                : (Math.Sin(_phase * 0.7) * (agentState == "running" ? 3.5 : 1.8) + _dragTiltAngle + extraTilt);

            if (_tailRotate != null) _tailRotate.Angle = Math.Sin(_phase * 1.6) * (agentState == "running" ? 14.0 : 8.5);
            if (_floatSubTransform != null) _floatSubTransform.Y = Math.Cos(_phase * 1.2) * 2.6;

            _blinkCountdown -= dt;
            if (_blinkCountdown <= 0)
            {
                _blinkActive = 0.14;
                _blinkCountdown = 2.6 + _rng.NextDouble() * 3.4;
            }
            double eyeY = sleepy ? 0.22 : (_blinkActive > 0 ? 0.14 : 1.0);
            if (_blinkActive > 0) _blinkActive = Math.Max(0, _blinkActive - dt);
            if (_eyeLeftScale != null) _eyeLeftScale.ScaleY = eyeY;
            if (_eyeRightScale != null) _eyeRightScale.ScaleY = eyeY;

            if (_mechaFaceText != null)
            {
                if (_dragging) _mechaFaceText.Text = "O  O";
                else if (_hopRemaining > 0) _mechaFaceText.Text = "^  ^";
                else if (agentState == "running") _mechaFaceText.Text = (((int)(_phase * 2)) % 2 == 0) ? ">  <" : "•  •";
                else if (agentState == "unread") _mechaFaceText.Text = "★  ★";
                else if (sleepy) _mechaFaceText.Text = "-  -";
                else if (_blinkActive > 0) _mechaFaceText.Text = "—  —";
                else _mechaFaceText.Text = "•  •";
            }

            if (_moodBadgeRunning != null) _moodBadgeRunning.Visibility = agentState == "running" ? Visibility.Visible : Visibility.Collapsed;
            if (_moodBadgeUnread != null) _moodBadgeUnread.Visibility = agentState == "unread" ? Visibility.Visible : Visibility.Collapsed;
            if (_moodBadgeSleep != null) _moodBadgeSleep.Visibility = sleepy ? Visibility.Visible : Visibility.Collapsed;

            // Animated sparkle particle update
            if (_sparkleText != null && _sparkleText.Visibility == Visibility.Visible)
            {
                _sparkleElapsed += dt;
                if (_sparkleElapsed >= _sparkleDuration)
                {
                    _sparkleText.Visibility = Visibility.Collapsed;
                }
                else
                {
                    double sp = _sparkleElapsed / _sparkleDuration;
                    _sparkleTranslate.Y = -26.0 * (1.0 - (1.0 - sp) * (1.0 - sp));
                    double sScale = sp < 0.25 ? (0.65 + (sp / 0.25) * 0.5) : (1.15 - (sp - 0.25) * 0.35);
                    _sparkleScale.ScaleX = sScale;
                    _sparkleScale.ScaleY = sScale;
                    _sparkleText.Opacity = sp < 0.65 ? 1.0 : Math.Max(0.0, 1.0 - (sp - 0.65) / 0.35);
                }
            }
        }

        private void HideBubbleImmediate()
        {
            _bubbleAnimGen++;
            _bubbleHideTimer.Stop();
            _bubbleBorder.BeginAnimation(UIElement.OpacityProperty, null);
            _bubbleScale.BeginAnimation(ScaleTransform.ScaleXProperty, null);
            _bubbleScale.BeginAnimation(ScaleTransform.ScaleYProperty, null);
            _bubbleTranslate.BeginAnimation(TranslateTransform.YProperty, null);
            _bubbleBorder.Visibility = Visibility.Collapsed;
        }

        private void HideBubbleAnimated()
        {
            if (_bubbleBorder.Visibility != Visibility.Visible) return;
            int gen = ++_bubbleAnimGen;
            var easeIn = new CubicEase { EasingMode = EasingMode.EaseIn };
            var dur = TimeSpan.FromMilliseconds(220);

            var fadeOut = new DoubleAnimation(0.0, dur) { EasingFunction = easeIn };
            fadeOut.Completed += delegate
            {
                if (_bubbleAnimGen == gen)
                {
                    _bubbleBorder.Visibility = Visibility.Collapsed;
                }
            };
            _bubbleBorder.BeginAnimation(UIElement.OpacityProperty, fadeOut);
            _bubbleScale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(0.92, dur) { EasingFunction = easeIn });
            _bubbleScale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(0.92, dur) { EasingFunction = easeIn });
            _bubbleTranslate.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(-7.0, dur) { EasingFunction = easeIn });
        }

        public void ShowBubble(string text, double durationSec)
        {
            ShowBubble(text, durationSec, false);
        }

        public void ShowBubble(string text, double durationSec, bool isTokenPop)
        {
            if (!_petConfig.showSpeechBubble || string.IsNullOrEmpty(text)) return;
            _bubbleAnimGen++;
            _bubbleHideTimer.Stop();

            _bubbleText.Text = text;
            _bubbleBorder.Visibility = Visibility.Visible;

            var popEase = new BackEase { Amplitude = 0.34, EasingMode = EasingMode.EaseOut };
            var fadeEase = new CubicEase { EasingMode = EasingMode.EaseOut };

            _bubbleBorder.BeginAnimation(
                UIElement.OpacityProperty,
                new DoubleAnimation(0.0, 1.0, TimeSpan.FromMilliseconds(180)) { EasingFunction = fadeEase });
            _bubbleScale.BeginAnimation(
                ScaleTransform.ScaleXProperty,
                new DoubleAnimation(0.80, 1.0, TimeSpan.FromMilliseconds(260)) { EasingFunction = popEase });
            _bubbleScale.BeginAnimation(
                ScaleTransform.ScaleYProperty,
                new DoubleAnimation(0.80, 1.0, TimeSpan.FromMilliseconds(260)) { EasingFunction = popEase });
            _bubbleTranslate.BeginAnimation(
                TranslateTransform.YProperty,
                new DoubleAnimation(10.0, 0.0, TimeSpan.FromMilliseconds(240)) { EasingFunction = fadeEase });

            _bubbleTotalDuration = Math.Max(1.6, durationSec);
            _bubbleUntilUtc = DateTime.UtcNow.AddSeconds(_bubbleTotalDuration);
            _bubbleHideTimer.Interval = TimeSpan.FromSeconds(_bubbleTotalDuration);
            _bubbleHideTimer.Start();

            if (isTokenPop)
            {
                _tokenBounceRemaining = 0.36;
                TriggerSparkle("⚡");
            }
        }

        private void TriggerPatInteraction()
        {
            _lastInteractUtc = DateTime.UtcNow;
            _wandering = false;
            _wanderCooldownSec = 9.0 + _rng.NextDouble() * 8.0;
            _hopRemaining = 0.58;
            _interactAnimRemaining = 1.6;
            string[] sparkles = new string[] { "✨", "♥", "★" };
            TriggerSparkle(sparkles[_rng.Next(sparkles.Length)]);
            if (!_petConfig.showSpeechBubble) return;

            string curTpl = (_petConfig != null && !string.IsNullOrEmpty(_petConfig.bubbleTemplate))
                ? _petConfig.bubbleTemplate
                : "入 {in} · 出 {out}";
            ShowBubble(RenderBubbleTemplate(curTpl), 4.4, true);
        }

        private void OnPetMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            _lastInteractUtc = DateTime.UtcNow;
            CloseActiveMenu();
            _wandering = false;
            if (e.ClickCount >= 2)
            {
                int pct = _telemetry != null ? _telemetry.percent : 0;
                bool hasTok = _telemetry != null && (_telemetry.latestInputTokens > 0 || _telemetry.latestOutputTokens > 0);
                if (hasTok)
                {
                    ShowBubble(string.Format("入 {0} · 出 {1} ({2}%)", FormatTokenCount(_telemetry.latestInputTokens), FormatTokenCount(_telemetry.latestOutputTokens), pct), 4.8, true);
                }
                else
                {
                    string model = (_telemetry != null && !string.IsNullOrEmpty(_telemetry.upstreamModelId)) ? _telemetry.upstreamModelId : "待机";
                    ShowBubble(string.Format("上下文 {0}% · {1}", pct, model), 4.2, false);
                }
                e.Handled = true;
                return;
            }
            _dragging = true;
            _dragMoved = false;
            _dragVelX = 0.0;
            PetNative.GetCursorPos(out _dragStartCursor);
            _dragStartLeft = Left;
            _dragStartTop = Top;
            _prevDragLeft = Left;
            _petHost.CaptureMouse();
            e.Handled = true;
        }

        private void OnPetMouseMove(object sender, System.Windows.Input.MouseEventArgs e)
        {
            if (_rightDown)
            {
                PetNative.POINT rCur;
                if (PetNative.GetCursorPos(out rCur))
                {
                    if (Math.Abs(rCur.X - _rightDownCursor.X) > 4 || Math.Abs(rCur.Y - _rightDownCursor.Y) > 4)
                    {
                        _rightMoved = true;
                        CloseActiveMenu();
                    }
                }
            }
            if (!_dragging) return;
            CloseActiveMenu();
            PetNative.POINT cur;
            if (!PetNative.GetCursorPos(out cur)) return;
            double dpiScale = _hwnd != IntPtr.Zero ? PetNative.GetWindowDpiScale(_hwnd) : 1.0;
            if (dpiScale <= 0) dpiScale = 1.0;
            double dx = (cur.X - _dragStartCursor.X) / dpiScale;
            double dy = (cur.Y - _dragStartCursor.Y) / dpiScale;
            if (Math.Abs(dx) > 4.0 || Math.Abs(dy) > 4.0) _dragMoved = true;
            if (_dragMoved)
            {
                double nextLeft;
                double nextTop;
                ClampToVirtualScreen(_dragStartLeft + dx, _dragStartTop + dy, out nextLeft, out nextTop);
                _dragVelX = Math.Max(-36.0, Math.Min(36.0, nextLeft - _prevDragLeft));
                _prevDragLeft = nextLeft;
                Left = nextLeft;
                Top = nextTop;
            }
        }

        private void OnPetMouseLeftButtonUp(object sender, MouseButtonEventArgs e)
        {
            if (!_dragging) return;
            _dragging = false;
            try { _petHost.ReleaseMouseCapture(); } catch { }
            if (_dragMoved)
            {
                _landBounceRemaining = 0.42;
                _wanderCooldownSec = 8.5 + _rng.NextDouble() * 8.0;
                Action<int, int> handler = PositionCommitted;
                if (handler != null) handler((int)Math.Round(Left), (int)Math.Round(Top));
            }
            else
            {
                TriggerPatInteraction();
            }
            e.Handled = true;
        }

        private void OnPetMouseRightButtonDown(object sender, MouseButtonEventArgs e)
        {
            _lastInteractUtc = DateTime.UtcNow;
            _wandering = false;
            _rightDown = true;
            _rightMoved = false;
            PetNative.GetCursorPos(out _rightDownCursor);
            if (_activeMenuWindow != null)
            {
                CloseActiveMenu();
            }
            e.Handled = true;
        }

        private void OnPetMouseRightButtonUp(object sender, MouseButtonEventArgs e)
        {
            _lastInteractUtc = DateTime.UtcNow;
            bool wasMoved = _rightMoved;
            _rightDown = false;
            _rightMoved = false;
            CloseActiveMenu();
            if (wasMoved)
            {
                e.Handled = true;
                return;
            }

            PetNative.POINT cursorPx;
            double cursorX = Left + Width * 0.5;
            double cursorY = Top + Height * 0.5;
            if (PetNative.GetCursorPos(out cursorPx))
            {
                double dpiScale = _hwnd != IntPtr.Zero ? PetNative.GetWindowDpiScale(_hwnd) : 1.0;
                if (dpiScale <= 0) dpiScale = 1.0;
                cursorX = cursorPx.X / dpiScale;
                cursorY = cursorPx.Y / dpiScale;
            }

            _menuOpenLeft = Left;
            _menuOpenTop = Top;
            var menuWin = new ThemedPetMenuWindow(
                _petConfig,
                _theme,
                delegate(string nextId)
                {
                    Action<string> h = SelectPetRequested;
                    if (h != null) h(nextId);
                },
                delegate(bool nextVal)
                {
                    Action<bool> h = ToggleBubbleRequested;
                    if (h != null) h(nextVal);
                },
                delegate(bool nextVal)
                {
                    Action<bool> h = ToggleTopmostRequested;
                    if (h != null) h(nextVal);
                },
                delegate(bool nextVal)
                {
                    Action<bool> h = ToggleWanderRequested;
                    if (h != null) h(nextVal);
                },
                delegate(bool nextVal)
                {
                    Action<bool> h = ToggleSelectableRequested;
                    if (h != null) h(nextVal);
                },
                delegate(int nextSize)
                {
                    Action<int> h = ChangeSizeRequested;
                    if (h != null) h(nextSize);
                },
                delegate
                {
                    Action h = ResetPositionRequested;
                    if (h != null) h();
                },
                delegate
                {
                    Action h = ClosePetRequested;
                    if (h != null) h();
                });

            _activeMenuWindow = menuWin;
            menuWin.Closed += delegate
            {
                if (ReferenceEquals(_activeMenuWindow, menuWin))
                {
                    _activeMenuWindow = null;
                }
            };
            menuWin.ShowAt(cursorX, cursorY);
            e.Handled = true;
        }
    }

    internal sealed class ThemedPetMenuWindow : Window
    {
        private readonly System.Windows.Media.Color _accent;
        private readonly System.Windows.Media.Color _tertiary;
        private readonly System.Windows.Media.Color _surface;
        private readonly System.Windows.Media.Color _hoverBg;
        private readonly System.Windows.Media.Color _textPrimary;
        private readonly System.Windows.Media.Color _textMuted;
        private readonly System.Windows.Media.Color _sepColor;
        private readonly System.Windows.Media.Color _dangerColor;
        private readonly bool _isLight;
        private readonly PetConfig _cfg;
        private readonly PetThemePalette _theme;
        private readonly Action<string> _onSelectPet;
        private Border _cardBorder;
        private ScaleTransform _cardScale;
        private TranslateTransform _cardTranslate;
        private Border _petTriggerRow;
        private TextBlock _activePetPillText;
        private ThemedPetSubMenuWindow _subMenu;
        private DispatcherTimer _subOpenTimer;
        private DispatcherTimer _subCloseTimer;
        private string _activePetId;
        private bool _closing = false;

        private static System.Windows.Media.Color ParseHex(string hex, System.Windows.Media.Color fallback)
        {
            try
            {
                if (!string.IsNullOrEmpty(hex))
                {
                    object parsed = System.Windows.Media.ColorConverter.ConvertFromString(hex);
                    if (parsed is System.Windows.Media.Color) return (System.Windows.Media.Color)parsed;
                }
            }
            catch { }
            return fallback;
        }

        private static System.Windows.Media.Color Blend(System.Windows.Media.Color a, System.Windows.Media.Color b, double t)
        {
            byte r = (byte)Math.Max(0, Math.Min(255, Math.Round(a.R * (1.0 - t) + b.R * t)));
            byte g = (byte)Math.Max(0, Math.Min(255, Math.Round(a.G * (1.0 - t) + b.G * t)));
            byte bl = (byte)Math.Max(0, Math.Min(255, Math.Round(a.B * (1.0 - t) + b.B * t)));
            return System.Windows.Media.Color.FromRgb(r, g, bl);
        }

        public ThemedPetMenuWindow(
            PetConfig cfg,
            PetThemePalette theme,
            Action<string> onSelectPet,
            Action<bool> onToggleBubble,
            Action<bool> onToggleTopmost,
            Action<bool> onToggleWander,
            Action<bool> onToggleSelectable,
            Action<int> onChangeSize,
            Action onResetPos,
            Action onClosePet)
        {
            _cfg = cfg ?? new PetConfig();
            _theme = theme ?? new PetThemePalette();
            _onSelectPet = onSelectPet;
            PetThemePalette pal = _theme;
            _accent = ParseHex(pal.accent, System.Windows.Media.Color.FromRgb(91, 140, 255));
            _tertiary = ParseHex(pal.tertiary, System.Windows.Media.Color.FromRgb(61, 194, 167));
            _surface = ParseHex(pal.chrome, System.Windows.Media.Color.FromRgb(27, 30, 40));
            System.Windows.Media.Color bubbleCol = ParseHex(pal.bubble, System.Windows.Media.Color.FromRgb(33, 37, 51));
            double lum = (0.299 * _surface.R + 0.587 * _surface.G + 0.114 * _surface.B) / 255.0;
            _isLight = lum >= 0.58;

            _hoverBg = _isLight ? Blend(_surface, _accent, 0.11) : Blend(bubbleCol, _accent, 0.14);
            _textPrimary = _isLight ? System.Windows.Media.Color.FromRgb(24, 28, 38) : System.Windows.Media.Color.FromRgb(236, 240, 250);
            _textMuted = _isLight ? System.Windows.Media.Color.FromRgb(98, 108, 128) : System.Windows.Media.Color.FromRgb(144, 154, 176);
            _sepColor = _isLight ? System.Windows.Media.Color.FromArgb(28, 20, 26, 40) : System.Windows.Media.Color.FromArgb(26, 255, 255, 255);
            _dangerColor = _isLight ? System.Windows.Media.Color.FromRgb(217, 65, 82) : System.Windows.Media.Color.FromRgb(244, 108, 122);

            Title = "AGY Pet Menu";
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            AllowsTransparency = true;
            Background = System.Windows.Media.Brushes.Transparent;
            ShowInTaskbar = false;
            Topmost = true;
            SizeToContent = SizeToContent.WidthAndHeight;
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;

            _subOpenTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(110) };
            _subOpenTimer.Tick += delegate
            {
                _subOpenTimer.Stop();
                OpenSubMenu();
            };
            _subCloseTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(220) };
            _subCloseTimer.Tick += delegate
            {
                _subCloseTimer.Stop();
                if (_subMenu != null && !_subMenu.IsMouseOver && (_petTriggerRow == null || !_petTriggerRow.IsMouseOver))
                {
                    CloseSubMenu();
                }
            };

            double corner = Math.Max(9.0, Math.Min(16.0, pal.radius + 2.0));
            var mainStack = new StackPanel { Orientation = System.Windows.Controls.Orientation.Vertical };

            // Secondary submenu trigger row for selecting pets (keeps main controls uncluttered!)
            _activePetId = !string.IsNullOrEmpty(_cfg.activePetId) ? _cfg.activePetId : "neko";
            _petTriggerRow = BuildSubMenuTriggerRow(ResolvePetDisplayName(_activePetId));
            mainStack.Children.Add(_petTriggerRow);

            mainStack.Children.Add(BuildDivider(6));

            // Toggles with custom mini pill switches & live size stepper (keep menu open while toggling!)
            bool bubbleOn = _cfg.showSpeechBubble;
            bool topmostOn = _cfg.alwaysOnTop;
            bool wanderOn = _cfg.autoWander;
            bool selectableOn = _cfg.selectable;
            int initialSize = Math.Max(60, Math.Min(500, _cfg.size));

            UIElement sizeRow = BuildSizeStepperRow(initialSize, onChangeSize);
            sizeRow.MouseEnter += delegate { ScheduleCloseSubMenu(); };
            mainStack.Children.Add(sizeRow);

            UIElement selectRow = BuildToggleRow("🖱", "允许被选中", selectableOn, delegate(bool nextVal)
            {
                if (onToggleSelectable != null) onToggleSelectable(nextVal);
                Topmost = true;
            });
            selectRow.MouseEnter += delegate { ScheduleCloseSubMenu(); };
            mainStack.Children.Add(selectRow);

            UIElement wanderRow = BuildToggleRow("🚶", "自主桌面漫步", wanderOn, delegate(bool nextVal)
            {
                if (onToggleWander != null) onToggleWander(nextVal);
            });
            wanderRow.MouseEnter += delegate { ScheduleCloseSubMenu(); };
            mainStack.Children.Add(wanderRow);

            UIElement bubbleRow = BuildToggleRow("💬", "显示互动气泡", bubbleOn, delegate(bool nextVal)
            {
                if (onToggleBubble != null) onToggleBubble(nextVal);
            });
            bubbleRow.MouseEnter += delegate { ScheduleCloseSubMenu(); };
            mainStack.Children.Add(bubbleRow);

            UIElement topmostRow = BuildToggleRow("📌", "桌面置顶悬浮", topmostOn, delegate(bool nextVal)
            {
                if (onToggleTopmost != null) onToggleTopmost(nextVal);
                Topmost = true;
            });
            topmostRow.MouseEnter += delegate { ScheduleCloseSubMenu(); };
            mainStack.Children.Add(topmostRow);

            UIElement resetRow = BuildActionRow("↺", "召回默认位置", false, delegate
            {
                CloseAndRun(delegate { if (onResetPos != null) onResetPos(); });
            });
            resetRow.MouseEnter += delegate { ScheduleCloseSubMenu(); };
            mainStack.Children.Add(resetRow);

            mainStack.Children.Add(BuildDivider(6));

            UIElement closeRow = BuildActionRow("✕", "关闭桌宠", true, delegate
            {
                CloseAndRun(delegate { if (onClosePet != null) onClosePet(); });
            });
            closeRow.MouseEnter += delegate { ScheduleCloseSubMenu(); };
            mainStack.Children.Add(closeRow);

            var cardScale = new ScaleTransform(0.95, 0.95);
            var cardTranslate = new TranslateTransform(0, -4);
            var cardTransform = new TransformGroup();
            cardTransform.Children.Add(cardScale);
            cardTransform.Children.Add(cardTranslate);

            var cardBorder = new Border
            {
                MinWidth = 204,
                MaxWidth = 248,
                Padding = new Thickness(6, 7, 6, 7),
                CornerRadius = new CornerRadius(corner),
                Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(_isLight ? (byte)248 : (byte)244, _surface.R, _surface.G, _surface.B)),
                BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(_isLight ? (byte)110 : (byte)105, _accent.R, _accent.G, _accent.B)),
                BorderThickness = new Thickness(1),
                Child = mainStack,
                RenderTransformOrigin = new System.Windows.Point(0.5, 0.0),
                RenderTransform = cardTransform,
                Opacity = 0.0,
                Effect = new DropShadowEffect
                {
                    Color = Colors.Black,
                    BlurRadius = 18,
                    ShadowDepth = 4,
                    Opacity = _isLight ? 0.22 : 0.56
                }
            };
            _cardBorder = cardBorder;
            _cardScale = cardScale;
            _cardTranslate = cardTranslate;

            // Outer transparent margin gives the drop shadow room without clipping
            Content = new Border
            {
                Padding = new Thickness(12),
                Background = System.Windows.Media.Brushes.Transparent,
                Child = cardBorder
            };

            SourceInitialized += delegate
            {
                IntPtr h = new WindowInteropHelper(this).Handle;
                if (h != IntPtr.Zero)
                {
                    long ex = PetNative.GetWindowLongPtrCompat(h, PetNative.GWL_EXSTYLE);
                    ex |= PetNative.WS_EX_TOOLWINDOW;
                    PetNative.SetWindowLongPtrCompat(h, PetNative.GWL_EXSTYLE, ex);
                }
            };

            Deactivated += delegate { ScheduleCheckFocusClose(); };
            KeyDown += delegate(object s, System.Windows.Input.KeyEventArgs ke)
            {
                if (ke.Key == Key.Escape)
                {
                    ke.Handled = true;
                    SafeClose();
                }
            };
        }

        private string ResolvePetDisplayName(string petId)
        {
            if (string.Equals(petId, "ghost", StringComparison.OrdinalIgnoreCase)) return "赛博小幽灵";
            if (string.Equals(petId, "mecha", StringComparison.OrdinalIgnoreCase)) return "机甲小助手";
            if (string.Equals(petId, "neko", StringComparison.OrdinalIgnoreCase)) return "暗夜小黑猫";
            if (_cfg != null && _cfg.customPets != null)
            {
                for (int i = 0; i < _cfg.customPets.Count; i++)
                {
                    CustomPetEntry cp = _cfg.customPets[i];
                    if (cp != null && string.Equals(cp.id, petId, StringComparison.OrdinalIgnoreCase))
                    {
                        return string.IsNullOrEmpty(cp.name) ? cp.id : cp.name;
                    }
                }
            }
            return "暗夜小黑猫";
        }

        private Border BuildSubMenuTriggerRow(string activeLabel)
        {
            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(22) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(14) });

            var iconTxt = new TextBlock
            {
                Text = "🐾",
                FontSize = 12.2,
                VerticalAlignment = VerticalAlignment.Center,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                Foreground = new SolidColorBrush(_accent)
            };
            var titleTxt = new TextBlock
            {
                Text = "切换桌宠",
                FontSize = 12.4,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(_textPrimary),
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(4, 0, 6, 0)
            };

            _activePetPillText = new TextBlock
            {
                Text = activeLabel,
                FontSize = 10.2,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(_accent),
                MaxWidth = 82,
                TextTrimming = TextTrimming.CharacterEllipsis
            };
            var activePill = new Border
            {
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(6, 1.5, 6, 1.5),
                Margin = new Thickness(0, 0, 4, 0),
                VerticalAlignment = VerticalAlignment.Center,
                Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(_isLight ? (byte)32 : (byte)40, _accent.R, _accent.G, _accent.B)),
                Child = _activePetPillText
            };

            var arrowTxt = new TextBlock
            {
                Text = "›",
                FontSize = 15,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(_textMuted),
                VerticalAlignment = VerticalAlignment.Center,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                Margin = new Thickness(0, -1, 0, 0)
            };

            Grid.SetColumn(iconTxt, 0);
            Grid.SetColumn(titleTxt, 1);
            Grid.SetColumn(activePill, 2);
            Grid.SetColumn(arrowTxt, 3);
            grid.Children.Add(iconTxt);
            grid.Children.Add(titleTxt);
            grid.Children.Add(activePill);
            grid.Children.Add(arrowTxt);

            Border row = WrapInteractiveRow(
                grid,
                new SolidColorBrush(System.Windows.Media.Color.FromArgb(_isLight ? (byte)16 : (byte)22, _accent.R, _accent.G, _accent.B)),
                new SolidColorBrush(System.Windows.Media.Color.FromArgb(48, _accent.R, _accent.G, _accent.B)),
                false,
                delegate
                {
                    _subOpenTimer.Stop();
                    _subCloseTimer.Stop();
                    if (_subMenu != null) CloseSubMenu();
                    else OpenSubMenu();
                });

            row.MouseEnter += delegate
            {
                _subCloseTimer.Stop();
                if (_subMenu == null) _subOpenTimer.Start();
            };
            row.MouseLeave += delegate
            {
                _subOpenTimer.Stop();
                ScheduleCloseSubMenu();
            };
            return row;
        }

        private void ScheduleCloseSubMenu()
        {
            _subOpenTimer.Stop();
            if (_subMenu != null)
            {
                _subCloseTimer.Stop();
                _subCloseTimer.Start();
            }
        }

        private void OpenSubMenu()
        {
            if (_closing || _subMenu != null) return;
            var sub = new ThemedPetSubMenuWindow(
                _cfg,
                _theme,
                _activePetId,
                delegate(string nextId)
                {
                    _activePetId = nextId;
                    if (_activePetPillText != null) _activePetPillText.Text = ResolvePetDisplayName(nextId);
                    if (_onSelectPet != null)
                    {
                        try { _onSelectPet(nextId); } catch { }
                    }
                    Topmost = true;
                },
                delegate { _subCloseTimer.Stop(); },
                delegate { ScheduleCloseSubMenu(); },
                delegate { ScheduleCheckFocusClose(); },
                delegate { SafeClose(); });
            _subMenu = sub;
            try { sub.Owner = this; } catch { }
            sub.Closed += delegate
            {
                if (ReferenceEquals(_subMenu, sub)) _subMenu = null;
            };
            sub.ShowBeside(this, _petTriggerRow);
        }

        private void CloseSubMenu()
        {
            _subOpenTimer.Stop();
            _subCloseTimer.Stop();
            if (_subMenu != null)
            {
                ThemedPetSubMenuWindow s = _subMenu;
                bool wasSubActive = s.IsActive;
                _subMenu = null;
                s.SafeClose();
                if (wasSubActive && !_closing)
                {
                    try { Activate(); } catch { }
                }
            }
        }

        private void ScheduleCheckFocusClose()
        {
            if (_closing) return;
            Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(delegate
            {
                if (_closing) return;
                bool subActive = _subMenu != null && _subMenu.IsActive;
                if (!IsActive && !subActive)
                {
                    SafeClose();
                }
            }));
        }

        private UIElement BuildDivider(double vertMargin)
        {
            return new Border
            {
                Height = 1,
                Margin = new Thickness(6, vertMargin, 6, vertMargin),
                Background = new SolidColorBrush(_sepColor)
            };
        }

        private UIElement BuildSizeStepperRow(int initialSize, Action<int> onChangeSize)
        {
            int currentSize = Math.Max(60, Math.Min(500, initialSize));
            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(22) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            var iconTxt = new TextBlock
            {
                Text = "↔",
                FontSize = 12,
                VerticalAlignment = VerticalAlignment.Center,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                Foreground = new SolidColorBrush(_textMuted)
            };
            var nameTxt = new TextBlock
            {
                Text = "桌宠大小",
                FontSize = 12.2,
                Foreground = new SolidColorBrush(_textPrimary),
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(4, 0, 6, 0)
            };

            var valTxt = new TextBlock
            {
                Text = currentSize.ToString(CultureInfo.InvariantCulture) + "%",
                FontSize = 11.2,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(_accent),
                VerticalAlignment = VerticalAlignment.Center,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                MinWidth = 40,
                TextAlignment = TextAlignment.Center,
                Cursor = System.Windows.Input.Cursors.Hand,
                ToolTip = "点击恢复 100%"
            };
            valTxt.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs ev)
            {
                ev.Handled = true;
                currentSize = 100;
                valTxt.Text = "100%";
                if (onChangeSize != null) onChangeSize(currentSize);
            };

            Func<string, Action, Border> makeStepBtn = delegate(string sym, Action onStep)
            {
                System.Windows.Media.Color normalCol = System.Windows.Media.Color.FromArgb(_isLight ? (byte)20 : (byte)28, _accent.R, _accent.G, _accent.B);
                System.Windows.Media.Color hoverCol = System.Windows.Media.Color.FromArgb(_isLight ? (byte)48 : (byte)68, _accent.R, _accent.G, _accent.B);
                var bgBrush = new SolidColorBrush(normalCol);
                var btnScale = new ScaleTransform(1.0, 1.0);
                var b = new Border
                {
                    Width = 22,
                    Height = 20,
                    CornerRadius = new CornerRadius(6),
                    Background = bgBrush,
                    BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(72, _accent.R, _accent.G, _accent.B)),
                    BorderThickness = new Thickness(1),
                    Cursor = System.Windows.Input.Cursors.Hand,
                    RenderTransformOrigin = new System.Windows.Point(0.5, 0.5),
                    RenderTransform = btnScale,
                    Child = new TextBlock
                    {
                        Text = sym,
                        FontSize = 12.5,
                        FontWeight = FontWeights.Bold,
                        Foreground = new SolidColorBrush(_textPrimary),
                        HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                        VerticalAlignment = VerticalAlignment.Center,
                        Margin = new Thickness(0, -1, 0, 0)
                    }
                };
                var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
                b.MouseEnter += delegate
                {
                    bgBrush.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(hoverCol, TimeSpan.FromMilliseconds(130)) { EasingFunction = ease });
                };
                b.MouseLeave += delegate
                {
                    bgBrush.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(normalCol, TimeSpan.FromMilliseconds(150)) { EasingFunction = ease });
                    btnScale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(1.0, TimeSpan.FromMilliseconds(120)) { EasingFunction = ease });
                    btnScale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(1.0, TimeSpan.FromMilliseconds(120)) { EasingFunction = ease });
                };
                b.MouseLeftButtonDown += delegate(object s, MouseButtonEventArgs ev)
                {
                    ev.Handled = true;
                    btnScale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(0.88, TimeSpan.FromMilliseconds(75)) { EasingFunction = ease });
                    btnScale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(0.88, TimeSpan.FromMilliseconds(75)) { EasingFunction = ease });
                };
                b.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs ev)
                {
                    ev.Handled = true;
                    btnScale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(1.0, TimeSpan.FromMilliseconds(140)) { EasingFunction = ease });
                    btnScale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(1.0, TimeSpan.FromMilliseconds(140)) { EasingFunction = ease });
                    if (onStep != null) onStep();
                };
                return b;
            };

            var minusBtn = makeStepBtn("−", delegate
            {
                int step = currentSize > 200 ? 25 : 10;
                currentSize = Math.Max(60, currentSize - step);
                valTxt.Text = currentSize.ToString(CultureInfo.InvariantCulture) + "%";
                if (onChangeSize != null) onChangeSize(currentSize);
            });
            var plusBtn = makeStepBtn("+", delegate
            {
                int step = currentSize >= 200 ? 25 : 10;
                currentSize = Math.Min(500, currentSize + step);
                valTxt.Text = currentSize.ToString(CultureInfo.InvariantCulture) + "%";
                if (onChangeSize != null) onChangeSize(currentSize);
            });

            var stepper = new StackPanel
            {
                Orientation = System.Windows.Controls.Orientation.Horizontal,
                VerticalAlignment = VerticalAlignment.Center
            };
            stepper.Children.Add(minusBtn);
            stepper.Children.Add(valTxt);
            stepper.Children.Add(plusBtn);

            Grid.SetColumn(iconTxt, 0);
            Grid.SetColumn(nameTxt, 1);
            Grid.SetColumn(stepper, 2);
            grid.Children.Add(iconTxt);
            grid.Children.Add(nameTxt);
            grid.Children.Add(stepper);

            return new Border
            {
                Padding = new Thickness(6, 5, 6, 5),
                Margin = new Thickness(0, 1, 0, 1),
                Child = grid
            };
        }

        private UIElement BuildToggleRow(string icon, string label, bool initialOn, Action<bool> onToggle)
        {
            bool currentOn = initialOn;
            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(22) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            var iconTxt = new TextBlock
            {
                Text = icon,
                FontSize = 12,
                VerticalAlignment = VerticalAlignment.Center,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                Foreground = new SolidColorBrush(_textMuted)
            };
            var nameTxt = new TextBlock
            {
                Text = label,
                FontSize = 12.2,
                Foreground = new SolidColorBrush(_textPrimary),
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(4, 0, 8, 0)
            };

            System.Windows.Media.Color offTrackCol = _isLight
                ? System.Windows.Media.Color.FromArgb(52, 30, 38, 56)
                : System.Windows.Media.Color.FromArgb(58, 255, 255, 255);
            System.Windows.Media.Color onTrackCol = _tertiary;
            var trackBrush = new SolidColorBrush(currentOn ? onTrackCol : offTrackCol);

            var thumbScale = new ScaleTransform(1.0, 1.0);
            var thumbShift = new TranslateTransform(currentOn ? 14.0 : 0.0, 0.0);
            var thumbTransform = new TransformGroup();
            thumbTransform.Children.Add(thumbScale);
            thumbTransform.Children.Add(thumbShift);

            var thumb = new Ellipse
            {
                Width = 12,
                Height = 12,
                Fill = new SolidColorBrush(Colors.White),
                HorizontalAlignment = System.Windows.HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Center,
                RenderTransformOrigin = new System.Windows.Point(0.5, 0.5),
                RenderTransform = thumbTransform,
                Effect = new DropShadowEffect
                {
                    Color = Colors.Black,
                    BlurRadius = 4,
                    ShadowDepth = 1,
                    Opacity = 0.28
                }
            };
            var pill = new Border
            {
                Width = 30,
                Height = 16,
                CornerRadius = new CornerRadius(8),
                Padding = new Thickness(2),
                Background = trackBrush,
                VerticalAlignment = VerticalAlignment.Center,
                Child = thumb
            };

            Grid.SetColumn(iconTxt, 0);
            Grid.SetColumn(nameTxt, 1);
            Grid.SetColumn(pill, 2);
            grid.Children.Add(iconTxt);
            grid.Children.Add(nameTxt);
            grid.Children.Add(pill);

            return WrapInteractiveRow(grid, System.Windows.Media.Brushes.Transparent, System.Windows.Media.Brushes.Transparent, false, delegate
            {
                currentOn = !currentOn;
                var slideEase = new CubicEase { EasingMode = EasingMode.EaseOut };
                trackBrush.BeginAnimation(
                    SolidColorBrush.ColorProperty,
                    new ColorAnimation(currentOn ? onTrackCol : offTrackCol, TimeSpan.FromMilliseconds(220)) { EasingFunction = slideEase });
                thumbShift.BeginAnimation(
                    TranslateTransform.XProperty,
                    new DoubleAnimation(currentOn ? 14.0 : 0.0, TimeSpan.FromMilliseconds(220)) { EasingFunction = slideEase });

                var squish = new DoubleAnimationUsingKeyFrames { Duration = TimeSpan.FromMilliseconds(220) };
                squish.KeyFrames.Add(new EasingDoubleKeyFrame(1.24, KeyTime.FromPercent(0.38), slideEase));
                squish.KeyFrames.Add(new EasingDoubleKeyFrame(1.0, KeyTime.FromPercent(1.0), slideEase));
                thumbScale.BeginAnimation(ScaleTransform.ScaleXProperty, squish);

                if (onToggle != null)
                {
                    try { onToggle(currentOn); } catch { }
                }
            });
        }

        private UIElement BuildActionRow(string icon, string label, bool isDanger, Action onClick)
        {
            System.Windows.Media.Color fg = isDanger ? _dangerColor : _textPrimary;
            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(22) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var iconTxt = new TextBlock
            {
                Text = icon,
                FontSize = 12,
                FontWeight = isDanger ? FontWeights.Bold : FontWeights.Normal,
                VerticalAlignment = VerticalAlignment.Center,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                Foreground = new SolidColorBrush(isDanger ? _dangerColor : _textMuted)
            };
            var nameTxt = new TextBlock
            {
                Text = label,
                FontSize = 12.2,
                FontWeight = isDanger ? FontWeights.Medium : FontWeights.Normal,
                Foreground = new SolidColorBrush(fg),
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(4, 0, 4, 0)
            };
            Grid.SetColumn(iconTxt, 0);
            Grid.SetColumn(nameTxt, 1);
            grid.Children.Add(iconTxt);
            grid.Children.Add(nameTxt);

            return WrapInteractiveRow(grid, System.Windows.Media.Brushes.Transparent, System.Windows.Media.Brushes.Transparent, isDanger, onClick);
        }

        private Border WrapInteractiveRow(UIElement child, System.Windows.Media.Brush normalBg, System.Windows.Media.Brush normalBorder, bool isDanger, Action onClick)
        {
            System.Windows.Media.Color hoverBgCol = isDanger
                ? System.Windows.Media.Color.FromArgb(_isLight ? (byte)28 : (byte)42, _dangerColor.R, _dangerColor.G, _dangerColor.B)
                : _hoverBg;
            System.Windows.Media.Color hoverBorderCol = isDanger
                ? System.Windows.Media.Color.FromArgb(80, _dangerColor.R, _dangerColor.G, _dangerColor.B)
                : System.Windows.Media.Color.FromArgb(64, _accent.R, _accent.G, _accent.B);

            var normBgSolid = normalBg as SolidColorBrush;
            var normBorderSolid = normalBorder as SolidColorBrush;
            System.Windows.Media.Color baseBgCol = (normBgSolid != null && normBgSolid.Color.A > 0)
                ? normBgSolid.Color
                : System.Windows.Media.Color.FromArgb(0, hoverBgCol.R, hoverBgCol.G, hoverBgCol.B);
            System.Windows.Media.Color baseBorderCol = (normBorderSolid != null && normBorderSolid.Color.A > 0)
                ? normBorderSolid.Color
                : System.Windows.Media.Color.FromArgb(0, hoverBorderCol.R, hoverBorderCol.G, hoverBorderCol.B);

            var bgBrush = new SolidColorBrush(baseBgCol);
            var borderBrush = new SolidColorBrush(baseBorderCol);
            var ease = new CubicEase { EasingMode = EasingMode.EaseOut };

            var row = new Border
            {
                CornerRadius = new CornerRadius(7),
                Padding = new Thickness(6, 6, 8, 6),
                Margin = new Thickness(0, 1, 0, 1),
                Background = bgBrush,
                BorderBrush = borderBrush,
                BorderThickness = new Thickness(1),
                Cursor = System.Windows.Input.Cursors.Hand,
                Child = child
            };
            row.MouseEnter += delegate
            {
                bgBrush.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(hoverBgCol, TimeSpan.FromMilliseconds(130)) { EasingFunction = ease });
                borderBrush.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(hoverBorderCol, TimeSpan.FromMilliseconds(130)) { EasingFunction = ease });
            };
            row.MouseLeave += delegate
            {
                bgBrush.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(baseBgCol, TimeSpan.FromMilliseconds(160)) { EasingFunction = ease });
                borderBrush.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(baseBorderCol, TimeSpan.FromMilliseconds(160)) { EasingFunction = ease });
            };
            row.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs ev)
            {
                ev.Handled = true;
                if (onClick != null) onClick();
            };
            return row;
        }

        public void ShowAt(double anchorX, double anchorY)
        {
            Left = -9999;
            Top = -9999;
            Show();
            UpdateLayout();

            double w = ActualWidth > 0 ? ActualWidth : 236;
            double h = ActualHeight > 0 ? ActualHeight : 280;
            Rect work = SystemParameters.WorkArea;
            try
            {
                var pt = new System.Drawing.Point((int)Math.Round(anchorX), (int)Math.Round(anchorY));
                Screen scr = Screen.FromPoint(pt);
                if (scr != null)
                {
                    IntPtr mh = new WindowInteropHelper(this).Handle;
                    double dpi = mh != IntPtr.Zero ? PetNative.GetWindowDpiScale(mh) : 1.0;
                    if (dpi <= 0) dpi = 1.0;
                    work = new Rect(
                        scr.WorkingArea.Left / dpi,
                        scr.WorkingArea.Top / dpi,
                        scr.WorkingArea.Width / dpi,
                        scr.WorkingArea.Height / dpi);
                }
            }
            catch { }

            double targetLeft = anchorX - 6;
            double targetTop = anchorY - 6;
            if (targetLeft + w > work.Right) targetLeft = anchorX - w + 12;
            if (targetTop + h > work.Bottom) targetTop = anchorY - h + 12;
            if (targetLeft < work.Left - 8) targetLeft = work.Left - 8;
            if (targetTop < work.Top - 8) targetTop = work.Top - 8;

            Left = Math.Round(targetLeft);
            Top = Math.Round(targetTop);
            if (_cardBorder != null)
            {
                var openEase = new CubicEase { EasingMode = EasingMode.EaseOut };
                _cardBorder.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0.0, 1.0, TimeSpan.FromMilliseconds(150)) { EasingFunction = openEase });
                _cardScale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(0.95, 1.0, TimeSpan.FromMilliseconds(160)) { EasingFunction = openEase });
                _cardScale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(0.95, 1.0, TimeSpan.FromMilliseconds(160)) { EasingFunction = openEase });
                _cardTranslate.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(-4.0, 0.0, TimeSpan.FromMilliseconds(160)) { EasingFunction = openEase });
            }
            Activate();
        }

        private void CloseAndRun(Action action)
        {
            SafeClose();
            if (action != null)
            {
                try { action(); } catch { }
            }
        }

        private void SafeClose()
        {
            if (_closing) return;
            _closing = true;
            try { _subOpenTimer.Stop(); } catch { }
            try { _subCloseTimer.Stop(); } catch { }
            CloseSubMenu();
            try { Close(); } catch { }
        }
    }

    internal sealed class ThemedPetSubMenuWindow : Window
    {
        private readonly System.Windows.Media.Color _accent;
        private readonly System.Windows.Media.Color _surface;
        private readonly System.Windows.Media.Color _hoverBg;
        private readonly System.Windows.Media.Color _textPrimary;
        private readonly System.Windows.Media.Color _textMuted;
        private readonly System.Windows.Media.Color _sepColor;
        private readonly bool _isLight;
        private readonly PetConfig _cfg;
        private readonly Action<string> _onSelectPet;
        private readonly StackPanel _listPanel;
        private readonly Border _cardBorder;
        private readonly ScaleTransform _cardScale;
        private readonly TranslateTransform _cardTranslate;
        private string _activePetId;
        private bool _closing = false;

        private static System.Windows.Media.Color ParseHex(string hex, System.Windows.Media.Color fallback)
        {
            try
            {
                if (!string.IsNullOrEmpty(hex))
                {
                    object parsed = System.Windows.Media.ColorConverter.ConvertFromString(hex);
                    if (parsed is System.Windows.Media.Color) return (System.Windows.Media.Color)parsed;
                }
            }
            catch { }
            return fallback;
        }

        private static System.Windows.Media.Color Blend(System.Windows.Media.Color a, System.Windows.Media.Color b, double t)
        {
            byte r = (byte)Math.Max(0, Math.Min(255, Math.Round(a.R * (1.0 - t) + b.R * t)));
            byte g = (byte)Math.Max(0, Math.Min(255, Math.Round(a.G * (1.0 - t) + b.G * t)));
            byte bl = (byte)Math.Max(0, Math.Min(255, Math.Round(a.B * (1.0 - t) + b.B * t)));
            return System.Windows.Media.Color.FromRgb(r, g, bl);
        }

        public ThemedPetSubMenuWindow(
            PetConfig cfg,
            PetThemePalette theme,
            string activePetId,
            Action<string> onSelectPet,
            Action onMouseEntered,
            Action onMouseLeft,
            Action onDeactivatedCheck,
            Action onEscapeAll)
        {
            _cfg = cfg ?? new PetConfig();
            _onSelectPet = onSelectPet;
            _activePetId = string.IsNullOrEmpty(activePetId) ? "neko" : activePetId;

            PetThemePalette pal = theme ?? new PetThemePalette();
            _accent = ParseHex(pal.accent, System.Windows.Media.Color.FromRgb(91, 140, 255));
            _surface = ParseHex(pal.chrome, System.Windows.Media.Color.FromRgb(27, 30, 40));
            System.Windows.Media.Color bubbleCol = ParseHex(pal.bubble, System.Windows.Media.Color.FromRgb(33, 37, 51));
            double lum = (0.299 * _surface.R + 0.587 * _surface.G + 0.114 * _surface.B) / 255.0;
            _isLight = lum >= 0.58;

            _hoverBg = _isLight ? Blend(_surface, _accent, 0.11) : Blend(bubbleCol, _accent, 0.14);
            _textPrimary = _isLight ? System.Windows.Media.Color.FromRgb(24, 28, 38) : System.Windows.Media.Color.FromRgb(236, 240, 250);
            _textMuted = _isLight ? System.Windows.Media.Color.FromRgb(98, 108, 128) : System.Windows.Media.Color.FromRgb(144, 154, 176);
            _sepColor = _isLight ? System.Windows.Media.Color.FromArgb(28, 20, 26, 40) : System.Windows.Media.Color.FromArgb(26, 255, 255, 255);

            Title = "AGY Pet Selector";
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            AllowsTransparency = true;
            Background = System.Windows.Media.Brushes.Transparent;
            ShowInTaskbar = false;
            ShowActivated = false;
            Topmost = true;
            SizeToContent = SizeToContent.WidthAndHeight;
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;

            double corner = Math.Max(9.0, Math.Min(16.0, pal.radius + 2.0));
            var rootStack = new StackPanel { Orientation = System.Windows.Controls.Orientation.Vertical };

            var headRow = new Grid { Margin = new Thickness(8, 3, 8, 5) };
            headRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            headRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var headTitle = new TextBlock
            {
                Text = "选择桌宠造型",
                FontSize = 10.5,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(_textMuted),
                VerticalAlignment = VerticalAlignment.Center
            };
            var headDot = new Ellipse
            {
                Width = 6,
                Height = 6,
                Fill = new SolidColorBrush(_accent),
                VerticalAlignment = VerticalAlignment.Center
            };
            Grid.SetColumn(headTitle, 0);
            Grid.SetColumn(headDot, 1);
            headRow.Children.Add(headTitle);
            headRow.Children.Add(headDot);
            rootStack.Children.Add(headRow);

            _listPanel = new StackPanel { Orientation = System.Windows.Controls.Orientation.Vertical };
            RebuildPetRows();

            var scroll = new ScrollViewer
            {
                Content = _listPanel,
                MaxHeight = 290,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled
            };
            rootStack.Children.Add(scroll);

            _cardScale = new ScaleTransform(0.95, 0.95);
            _cardTranslate = new TranslateTransform(-6, 0);
            var tg = new TransformGroup();
            tg.Children.Add(_cardScale);
            tg.Children.Add(_cardTranslate);

            _cardBorder = new Border
            {
                MinWidth = 196,
                MaxWidth = 244,
                Padding = new Thickness(6, 7, 6, 7),
                CornerRadius = new CornerRadius(corner),
                Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(_isLight ? (byte)248 : (byte)244, _surface.R, _surface.G, _surface.B)),
                BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(_isLight ? (byte)110 : (byte)105, _accent.R, _accent.G, _accent.B)),
                BorderThickness = new Thickness(1),
                Child = rootStack,
                RenderTransformOrigin = new System.Windows.Point(0.0, 0.2),
                RenderTransform = tg,
                Opacity = 0.0,
                Effect = new DropShadowEffect
                {
                    Color = Colors.Black,
                    BlurRadius = 18,
                    ShadowDepth = 4,
                    Opacity = _isLight ? 0.22 : 0.56
                }
            };

            Content = new Border
            {
                Padding = new Thickness(12),
                Background = System.Windows.Media.Brushes.Transparent,
                Child = _cardBorder
            };

            SourceInitialized += delegate
            {
                IntPtr h = new WindowInteropHelper(this).Handle;
                if (h != IntPtr.Zero)
                {
                    long ex = PetNative.GetWindowLongPtrCompat(h, PetNative.GWL_EXSTYLE);
                    ex |= PetNative.WS_EX_TOOLWINDOW;
                    PetNative.SetWindowLongPtrCompat(h, PetNative.GWL_EXSTYLE, ex);
                }
            };

            MouseEnter += delegate { if (onMouseEntered != null) onMouseEntered(); };
            MouseLeave += delegate { if (onMouseLeft != null) onMouseLeft(); };
            Deactivated += delegate { if (onDeactivatedCheck != null) onDeactivatedCheck(); };
            KeyDown += delegate(object s, System.Windows.Input.KeyEventArgs ke)
            {
                if (ke.Key == Key.Escape)
                {
                    ke.Handled = true;
                    if (onEscapeAll != null) onEscapeAll();
                }
            };
        }

        private void RebuildPetRows()
        {
            _listPanel.Children.Clear();
            _listPanel.Children.Add(BuildSubPetRow("🐱", "暗夜小黑猫", "", "neko"));
            _listPanel.Children.Add(BuildSubPetRow("👻", "赛博小幽灵", "", "ghost"));
            _listPanel.Children.Add(BuildSubPetRow("🤖", "机甲小助手", "", "mecha"));

            if (_cfg != null && _cfg.customPets != null && _cfg.customPets.Count > 0)
            {
                _listPanel.Children.Add(new Border
                {
                    Height = 1,
                    Margin = new Thickness(6, 5, 6, 5),
                    Background = new SolidColorBrush(_sepColor)
                });
                for (int i = 0; i < _cfg.customPets.Count; i++)
                {
                    CustomPetEntry cp = _cfg.customPets[i];
                    if (cp == null || string.IsNullOrEmpty(cp.id)) continue;
                    bool isFrames = string.Equals(cp.kind, "frames", StringComparison.OrdinalIgnoreCase);
                    string icon = isFrames ? "🎞" : "🖼";
                    string tag = isFrames ? (cp.fps.ToString(CultureInfo.InvariantCulture) + "fps") : "图";
                    _listPanel.Children.Add(BuildSubPetRow(icon, string.IsNullOrEmpty(cp.name) ? cp.id : cp.name, tag, cp.id));
                }
            }
        }

        private UIElement BuildSubPetRow(string icon, string label, string badgeText, string petId)
        {
            string capturedId = petId;
            bool isActive = string.Equals(_activePetId, capturedId, StringComparison.OrdinalIgnoreCase);

            System.Windows.Media.Color baseBgCol = isActive
                ? System.Windows.Media.Color.FromArgb(_isLight ? (byte)36 : (byte)42, _accent.R, _accent.G, _accent.B)
                : System.Windows.Media.Color.FromArgb(0, _hoverBg.R, _hoverBg.G, _hoverBg.B);
            System.Windows.Media.Color baseBorderCol = isActive
                ? System.Windows.Media.Color.FromArgb(90, _accent.R, _accent.G, _accent.B)
                : System.Windows.Media.Color.FromArgb(0, _accent.R, _accent.G, _accent.B);
            System.Windows.Media.Color hoverBorderCol = System.Windows.Media.Color.FromArgb(64, _accent.R, _accent.G, _accent.B);

            var bgBrush = new SolidColorBrush(baseBgCol);
            var borderBrush = new SolidColorBrush(baseBorderCol);
            var ease = new CubicEase { EasingMode = EasingMode.EaseOut };

            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(22) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(18) });

            var iconTxt = new TextBlock
            {
                Text = icon,
                FontSize = 12.5,
                VerticalAlignment = VerticalAlignment.Center,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                Foreground = new SolidColorBrush(isActive ? _accent : _textPrimary)
            };
            var nameTxt = new TextBlock
            {
                Text = label,
                FontSize = 12.2,
                FontWeight = isActive ? FontWeights.SemiBold : FontWeights.Normal,
                Foreground = new SolidColorBrush(_textPrimary),
                TextTrimming = TextTrimming.CharacterEllipsis,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(4, 0, 6, 0)
            };
            Grid.SetColumn(iconTxt, 0);
            Grid.SetColumn(nameTxt, 1);
            grid.Children.Add(iconTxt);
            grid.Children.Add(nameTxt);

            if (!string.IsNullOrEmpty(badgeText))
            {
                var badge = new Border
                {
                    CornerRadius = new CornerRadius(6),
                    Padding = new Thickness(5, 1, 5, 1),
                    Margin = new Thickness(0, 0, 5, 0),
                    VerticalAlignment = VerticalAlignment.Center,
                    Background = new SolidColorBrush(System.Windows.Media.Color.FromArgb(36, _accent.R, _accent.G, _accent.B)),
                    Child = new TextBlock
                    {
                        Text = badgeText,
                        FontSize = 9.5,
                        FontWeight = FontWeights.SemiBold,
                        Foreground = new SolidColorBrush(_accent)
                    }
                };
                Grid.SetColumn(badge, 2);
                grid.Children.Add(badge);
            }

            if (isActive)
            {
                var checkTxt = new TextBlock
                {
                    Text = "✓",
                    FontSize = 12,
                    FontWeight = FontWeights.Bold,
                    Foreground = new SolidColorBrush(_accent),
                    VerticalAlignment = VerticalAlignment.Center,
                    HorizontalAlignment = System.Windows.HorizontalAlignment.Center
                };
                Grid.SetColumn(checkTxt, 3);
                grid.Children.Add(checkTxt);
            }

            var row = new Border
            {
                CornerRadius = new CornerRadius(7),
                Padding = new Thickness(6, 6, 8, 6),
                Margin = new Thickness(0, 1, 0, 1),
                Background = bgBrush,
                BorderBrush = borderBrush,
                BorderThickness = new Thickness(1),
                Cursor = System.Windows.Input.Cursors.Hand,
                Child = grid
            };
            row.MouseEnter += delegate
            {
                bgBrush.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(_hoverBg, TimeSpan.FromMilliseconds(130)) { EasingFunction = ease });
                borderBrush.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(hoverBorderCol, TimeSpan.FromMilliseconds(130)) { EasingFunction = ease });
            };
            row.MouseLeave += delegate
            {
                bgBrush.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(baseBgCol, TimeSpan.FromMilliseconds(160)) { EasingFunction = ease });
                borderBrush.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(baseBorderCol, TimeSpan.FromMilliseconds(160)) { EasingFunction = ease });
            };
            row.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs ev)
            {
                ev.Handled = true;
                _activePetId = capturedId;
                RebuildPetRows();
                if (_onSelectPet != null)
                {
                    try { _onSelectPet(capturedId); } catch { }
                }
            };
            return row;
        }

        public void ShowBeside(Window parentMenu, FrameworkElement triggerEl)
        {
            Left = -9999;
            Top = -9999;
            Show();
            UpdateLayout();

            double w = ActualWidth > 0 ? ActualWidth : 228;
            double h = ActualHeight > 0 ? ActualHeight : 220;
            double parentLeft = parentMenu != null ? parentMenu.Left : 0;
            double parentTop = parentMenu != null ? parentMenu.Top : 0;
            double parentW = (parentMenu != null && parentMenu.ActualWidth > 0) ? parentMenu.ActualWidth : 236;

            double anchorTop = parentTop;
            try
            {
                if (parentMenu != null && triggerEl != null)
                {
                    System.Windows.Point rel = triggerEl.TransformToAncestor(parentMenu).Transform(new System.Windows.Point(0, 0));
                    anchorTop = parentTop + rel.Y - 18.0;
                }
            }
            catch { }

            Rect work = SystemParameters.WorkArea;
            try
            {
                IntPtr mh = new WindowInteropHelper(this).Handle;
                double dpi = mh != IntPtr.Zero ? PetNative.GetWindowDpiScale(mh) : 1.0;
                if (dpi <= 0) dpi = 1.0;
                var pt = new System.Drawing.Point((int)Math.Round((parentLeft + parentW * 0.5) * dpi), (int)Math.Round((parentTop + 40) * dpi));
                Screen scr = Screen.FromPoint(pt);
                if (scr != null)
                {
                    work = new Rect(
                        scr.WorkingArea.Left / dpi,
                        scr.WorkingArea.Top / dpi,
                        scr.WorkingArea.Width / dpi,
                        scr.WorkingArea.Height / dpi);
                }
            }
            catch { }

            // Place cleanly on the right of primary menu; flip to the left if near right screen edge
            bool openLeft = false;
            double targetLeft = parentLeft + parentW - 18.0;
            if (targetLeft + w > work.Right + 6.0)
            {
                targetLeft = parentLeft - w + 18.0;
                openLeft = true;
            }
            if (targetLeft < work.Left - 8.0) targetLeft = work.Left - 8.0;

            double targetTop = anchorTop;
            if (targetTop + h > work.Bottom + 6.0) targetTop = work.Bottom - h + 6.0;
            if (targetTop < work.Top - 8.0) targetTop = work.Top - 8.0;

            Left = Math.Round(targetLeft);
            Top = Math.Round(targetTop);

            var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
            _cardBorder.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0.0, 1.0, TimeSpan.FromMilliseconds(150)) { EasingFunction = ease });
            _cardScale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(0.95, 1.0, TimeSpan.FromMilliseconds(160)) { EasingFunction = ease });
            _cardScale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(0.95, 1.0, TimeSpan.FromMilliseconds(160)) { EasingFunction = ease });
            _cardTranslate.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation(openLeft ? 6.0 : -6.0, 0.0, TimeSpan.FromMilliseconds(160)) { EasingFunction = ease });
        }

        public void SafeClose()
        {
            if (_closing) return;
            _closing = true;
            try { Close(); } catch { }
        }
    }

    internal sealed class PetLockBadgeWindow : Window
    {
        private readonly Border _pill;
        private readonly SolidColorBrush _bgBrush;
        private readonly SolidColorBrush _borderBrush;
        private readonly SolidColorBrush _iconBrush;
        private readonly System.Windows.Shapes.Path _lockedShackle;
        private readonly System.Windows.Shapes.Path _unlockedShackle;
        private readonly ScaleTransform _pillScale;
        private readonly TranslateTransform _pillShift;
        private readonly Action _onUnlockClick;

        private System.Windows.Media.Color _baseBg;
        private System.Windows.Media.Color _hoverBg;
        private System.Windows.Media.Color _baseBorder;
        private System.Windows.Media.Color _accentCol;
        private System.Windows.Media.Color _unlockCol;
        private System.Windows.Media.Color _iconCol;
        private bool _isUnlockedVisual = false;
        private bool _isShowing = false;
        private bool _fadingOut = false;
        private string _appliedThemeKey = "";

        public bool IsShowing { get { return _isShowing; } }

        private static System.Windows.Media.Color ParseHex(string hex, System.Windows.Media.Color fallback)
        {
            try
            {
                if (!string.IsNullOrEmpty(hex))
                {
                    object parsed = System.Windows.Media.ColorConverter.ConvertFromString(hex);
                    if (parsed is System.Windows.Media.Color) return (System.Windows.Media.Color)parsed;
                }
            }
            catch { }
            return fallback;
        }

        public PetLockBadgeWindow(PetThemePalette theme, Action onUnlockClick)
        {
            _onUnlockClick = onUnlockClick;
            Title = "AGY Pet Lock";
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            AllowsTransparency = true;
            Background = System.Windows.Media.Brushes.Transparent;
            ShowInTaskbar = false;
            ShowActivated = false;
            Topmost = true;
            Width = 54;
            Height = 54;
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;

            _bgBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(236, 27, 30, 40));
            _borderBrush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(140, 91, 140, 255));
            _iconBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(236, 240, 250));

            var iconCanvas = new Canvas
            {
                Width = 16,
                Height = 16,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };

            // Lock body (rounded rectangle + keyhole)
            var lockBody = new System.Windows.Shapes.Rectangle
            {
                Width = 10,
                Height = 7.2,
                RadiusX = 2.0,
                RadiusY = 2.0,
                Stroke = _iconBrush,
                StrokeThickness = 1.65,
                Fill = System.Windows.Media.Brushes.Transparent
            };
            Canvas.SetLeft(lockBody, 3.0);
            Canvas.SetTop(lockBody, 7.6);
            iconCanvas.Children.Add(lockBody);

            var keyhole = new Ellipse
            {
                Width = 2.2,
                Height = 2.2,
                Fill = _iconBrush
            };
            Canvas.SetLeft(keyhole, 6.9);
            Canvas.SetTop(keyhole, 10.1);
            iconCanvas.Children.Add(keyhole);

            // Closed shackle (Locked)
            _lockedShackle = new System.Windows.Shapes.Path
            {
                Data = Geometry.Parse("M 5.3,7.6 V 5.1 C 5.3,3.1 10.7,3.1 10.7,5.1 V 7.6"),
                Stroke = _iconBrush,
                StrokeThickness = 1.65,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round
            };
            iconCanvas.Children.Add(_lockedShackle);

            // Open lifted shackle (Unlocked)
            _unlockedShackle = new System.Windows.Shapes.Path
            {
                Data = Geometry.Parse("M 5.3,7.6 V 4.7 C 5.3,2.5 10.7,2.5 10.7,4.5"),
                Stroke = _iconBrush,
                StrokeThickness = 1.65,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round,
                Visibility = Visibility.Collapsed
            };
            iconCanvas.Children.Add(_unlockedShackle);

            _pillScale = new ScaleTransform(0.82, 0.82);
            _pillShift = new TranslateTransform(0, 6);
            var tg = new TransformGroup();
            tg.Children.Add(_pillScale);
            tg.Children.Add(_pillShift);

            _pill = new Border
            {
                Width = 34,
                Height = 34,
                CornerRadius = new CornerRadius(11),
                Background = _bgBrush,
                BorderBrush = _borderBrush,
                BorderThickness = new Thickness(1.2),
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                Cursor = System.Windows.Input.Cursors.Hand,
                ToolTip = "已锁定鼠标穿透 · 点击解锁桌宠",
                RenderTransformOrigin = new System.Windows.Point(0.5, 0.5),
                RenderTransform = tg,
                Opacity = 0.0,
                Child = iconCanvas,
                Effect = new DropShadowEffect
                {
                    Color = Colors.Black,
                    BlurRadius = 12,
                    ShadowDepth = 2,
                    Opacity = 0.48
                }
            };

            var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
            _pill.MouseEnter += delegate
            {
                if (_isUnlockedVisual) return;
                _bgBrush.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(_hoverBg, TimeSpan.FromMilliseconds(130)) { EasingFunction = ease });
                _borderBrush.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(_accentCol, TimeSpan.FromMilliseconds(130)) { EasingFunction = ease });
                _pillScale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(1.08, TimeSpan.FromMilliseconds(140)) { EasingFunction = ease });
                _pillScale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(1.08, TimeSpan.FromMilliseconds(140)) { EasingFunction = ease });
            };
            _pill.MouseLeave += delegate
            {
                if (_isUnlockedVisual) return;
                _bgBrush.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(_baseBg, TimeSpan.FromMilliseconds(160)) { EasingFunction = ease });
                _borderBrush.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(_baseBorder, TimeSpan.FromMilliseconds(160)) { EasingFunction = ease });
                _pillScale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(1.0, TimeSpan.FromMilliseconds(140)) { EasingFunction = ease });
                _pillScale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(1.0, TimeSpan.FromMilliseconds(140)) { EasingFunction = ease });
            };
            _pill.MouseLeftButtonDown += delegate(object s, MouseButtonEventArgs ev)
            {
                ev.Handled = true;
                if (_isUnlockedVisual) return;
                _pillScale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(0.92, TimeSpan.FromMilliseconds(70)) { EasingFunction = ease });
                _pillScale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(0.92, TimeSpan.FromMilliseconds(70)) { EasingFunction = ease });
            };
            _pill.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs ev)
            {
                ev.Handled = true;
                if (_isUnlockedVisual) return;
                TriggerUnlockVisual();
                if (_onUnlockClick != null)
                {
                    try { _onUnlockClick(); } catch { }
                }
            };

            Content = new Grid { Background = System.Windows.Media.Brushes.Transparent, Children = { _pill } };

            SourceInitialized += delegate
            {
                IntPtr h = new WindowInteropHelper(this).Handle;
                if (h != IntPtr.Zero)
                {
                    long ex = PetNative.GetWindowLongPtrCompat(h, PetNative.GWL_EXSTYLE);
                    ex |= PetNative.WS_EX_TOOLWINDOW | PetNative.WS_EX_NOACTIVATE;
                    PetNative.SetWindowLongPtrCompat(h, PetNative.GWL_EXSTYLE, ex);
                    HwndSource src = HwndSource.FromHwnd(h);
                    if (src != null) src.AddHook(WndProc);
                }
            };

            ApplyTheme(theme, true);
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == 0x0021) // WM_MOUSEACTIVATE -> never steal focus from games!
            {
                handled = true;
                return new IntPtr(3); // MA_NOACTIVATE
            }
            return IntPtr.Zero;
        }

        public void ApplyTheme(PetThemePalette theme, bool topmost)
        {
            Topmost = topmost;
            PetThemePalette pal = theme ?? new PetThemePalette();
            string key = (pal.accent ?? "") + "|" + (pal.tertiary ?? "") + "|" + (pal.chrome ?? "") + "|" + (pal.bubble ?? "");
            if (string.Equals(key, _appliedThemeKey, StringComparison.Ordinal)) return;
            _appliedThemeKey = key;
            _accentCol = ParseHex(pal.accent, System.Windows.Media.Color.FromRgb(91, 140, 255));
            _unlockCol = ParseHex(pal.tertiary, System.Windows.Media.Color.FromRgb(61, 194, 167));
            System.Windows.Media.Color surface = ParseHex(pal.chrome, System.Windows.Media.Color.FromRgb(27, 30, 40));
            System.Windows.Media.Color bubble = ParseHex(pal.bubble, System.Windows.Media.Color.FromRgb(33, 37, 51));
            bool isLight = ((0.299 * surface.R + 0.587 * surface.G + 0.114 * surface.B) / 255.0) >= 0.58;

            _baseBg = System.Windows.Media.Color.FromArgb(isLight ? (byte)242 : (byte)236, surface.R, surface.G, surface.B);
            _hoverBg = System.Windows.Media.Color.FromArgb(248, bubble.R, bubble.G, bubble.B);
            _baseBorder = System.Windows.Media.Color.FromArgb(140, _accentCol.R, _accentCol.G, _accentCol.B);
            _iconCol = isLight ? System.Windows.Media.Color.FromRgb(28, 32, 44) : System.Windows.Media.Color.FromRgb(236, 240, 250);

            if (!_isUnlockedVisual)
            {
                _bgBrush.BeginAnimation(SolidColorBrush.ColorProperty, null);
                _borderBrush.BeginAnimation(SolidColorBrush.ColorProperty, null);
                _iconBrush.BeginAnimation(SolidColorBrush.ColorProperty, null);
                _bgBrush.Color = _baseBg;
                _borderBrush.Color = _baseBorder;
                _iconBrush.Color = _iconCol;
            }
        }

        public void ShowLocked()
        {
            if (_isShowing && !_fadingOut && !_isUnlockedVisual) return;
            _fadingOut = false;
            _isUnlockedVisual = false;
            _lockedShackle.Visibility = Visibility.Visible;
            _unlockedShackle.Visibility = Visibility.Collapsed;
            _pill.ToolTip = "已锁定鼠标穿透 · 点击解锁桌宠";

            _bgBrush.BeginAnimation(SolidColorBrush.ColorProperty, null);
            _borderBrush.BeginAnimation(SolidColorBrush.ColorProperty, null);
            _iconBrush.BeginAnimation(SolidColorBrush.ColorProperty, null);
            _bgBrush.Color = _baseBg;
            _borderBrush.Color = _baseBorder;
            _iconBrush.Color = _iconCol;

            if (Visibility != Visibility.Visible)
            {
                Show();
            }
            _isShowing = true;

            var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
            _pill.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(1.0, TimeSpan.FromMilliseconds(160)) { EasingFunction = ease });
            _pillScale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(1.0, TimeSpan.FromMilliseconds(180)) { EasingFunction = ease });
            _pillScale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(1.0, TimeSpan.FromMilliseconds(180)) { EasingFunction = ease });
            _pillShift.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(0.0, TimeSpan.FromMilliseconds(180)) { EasingFunction = ease });
        }

        private void TriggerUnlockVisual()
        {
            _isUnlockedVisual = true;
            _fadingOut = false;
            _lockedShackle.Visibility = Visibility.Collapsed;
            _unlockedShackle.Visibility = Visibility.Visible;
            _pill.ToolTip = "已解锁";

            var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
            System.Windows.Media.Color unlockBg = System.Windows.Media.Color.FromArgb(242, _unlockCol.R, _unlockCol.G, _unlockCol.B);
            _bgBrush.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(unlockBg, TimeSpan.FromMilliseconds(170)) { EasingFunction = ease });
            _borderBrush.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(Colors.White, TimeSpan.FromMilliseconds(170)) { EasingFunction = ease });
            _iconBrush.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(Colors.White, TimeSpan.FromMilliseconds(170)) { EasingFunction = ease });

            var pop = new DoubleAnimationUsingKeyFrames { Duration = TimeSpan.FromMilliseconds(260) };
            pop.KeyFrames.Add(new EasingDoubleKeyFrame(1.22, KeyTime.FromPercent(0.45), ease));
            pop.KeyFrames.Add(new EasingDoubleKeyFrame(1.0, KeyTime.FromPercent(1.0), ease));
            _pillScale.BeginAnimation(ScaleTransform.ScaleXProperty, pop);
            _pillScale.BeginAnimation(ScaleTransform.ScaleYProperty, pop);
        }

        public void FadeOutAndHide()
        {
            if (!_isShowing || _fadingOut) return;
            _fadingOut = true;
            var ease = new CubicEase { EasingMode = EasingMode.EaseIn };
            var fade = new DoubleAnimation(0.0, TimeSpan.FromMilliseconds(150)) { EasingFunction = ease };
            fade.Completed += delegate
            {
                if (_fadingOut)
                {
                    _isShowing = false;
                    _fadingOut = false;
                    _isUnlockedVisual = false;
                    try { Hide(); } catch { }
                }
            };
            _pill.BeginAnimation(UIElement.OpacityProperty, fade);
            _pillScale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(0.84, TimeSpan.FromMilliseconds(150)) { EasingFunction = ease });
            _pillScale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(0.84, TimeSpan.FromMilliseconds(150)) { EasingFunction = ease });
            _pillShift.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(5.0, TimeSpan.FromMilliseconds(150)) { EasingFunction = ease });
        }

        public void ForceClose()
        {
            _isShowing = false;
            try { Close(); } catch { }
        }
    }

    internal sealed class PetHostController : IDisposable
    {
        private const string StopEventName = @"Local\AgyDesktopPetStop";
        private static readonly Encoding Utf8NoBom = new UTF8Encoding(false);

        private readonly string _dataDir;
        private readonly string _petConfigPath;
        private readonly string _petStatusPath;
        private readonly string _hudTelemetryPath;
        private readonly string _themesPath;
        private readonly Dispatcher _dispatcher;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();
        private readonly int _selfPid;

        private FileSystemWatcher _watcher;
        private DispatcherTimer _pollTimer;
        private Thread _stopThread;
        private EventWaitHandle _stopEvent;
        private DesktopPetWindow _petWindow;
        private PetConfig _petConfig = new PetConfig();
        private PetTelemetry _telemetry = new PetTelemetry();
        private PetThemePalette _themePalette = new PetThemePalette();
        private DateTime _lastPetWriteUtc = DateTime.MinValue;
        private long _lastPetLen = -1;
        private DateTime _lastHudWriteUtc = DateTime.MinValue;
        private long _lastHudLen = -1;
        private DateTime _lastThemeWriteUtc = DateTime.MinValue;
        private long _lastThemeLen = -1;
        private DateTime _lastStatusWriteUtc = DateTime.MinValue;
        private volatile bool _disposed = false;

        public PetHostController(string dataDir, Dispatcher dispatcher)
        {
            _dataDir = dataDir;
            _petConfigPath = System.IO.Path.Combine(_dataDir, "pet_config.json");
            _petStatusPath = System.IO.Path.Combine(_dataDir, "pet_status.json");
            _hudTelemetryPath = System.IO.Path.Combine(_dataDir, "hud_telemetry.json");
            _themesPath = System.IO.Path.Combine(_dataDir, "themes.json");
            _dispatcher = dispatcher;
            using (Process p = Process.GetCurrentProcess()) _selfPid = p.Id;
        }

        public void Start()
        {
            Directory.CreateDirectory(_dataDir);
            ReloadThemePalette();
            ReloadTelemetry();
            ReloadPetConfig();
            InstallWatcher();
            StartStopListener();

            _pollTimer = new DispatcherTimer(DispatcherPriority.Background, _dispatcher);
            _pollTimer.Interval = TimeSpan.FromMilliseconds(1000);
            _pollTimer.Tick += delegate
            {
                if (_disposed) return;
                CheckFiles();
                if ((DateTime.UtcNow - _lastStatusWriteUtc).TotalSeconds >= 3.0)
                {
                    WriteStatusFile(true);
                }
            };
            _pollTimer.Start();

            SyncPetWindow(true);
            WriteStatusFile(true);
        }

        private void StartStopListener()
        {
            _stopEvent = new EventWaitHandle(false, EventResetMode.ManualReset, StopEventName);
            _stopThread = new Thread(delegate()
            {
                try
                {
                    _stopEvent.WaitOne();
                    if (!_disposed) _dispatcher.BeginInvoke(new Action(ShutdownGracefully));
                }
                catch { }
            });
            _stopThread.IsBackground = true;
            _stopThread.Start();
        }

        private void InstallWatcher()
        {
            try
            {
                _watcher = new FileSystemWatcher(_dataDir, "*");
                _watcher.NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.CreationTime | NotifyFilters.FileName | NotifyFilters.Size;
                FileSystemEventHandler onEvt = delegate(object s, FileSystemEventArgs e)
                {
                    if (e != null) OnFileName(e.Name);
                };
                _watcher.Changed += onEvt;
                _watcher.Created += onEvt;
                _watcher.Renamed += delegate(object s, RenamedEventArgs e)
                {
                    OnFileName(e.Name);
                    OnFileName(e.OldName);
                };
                _watcher.EnableRaisingEvents = true;
            }
            catch { }
        }

        private static bool IsTarget(string name, string expected)
        {
            return !string.IsNullOrEmpty(name) &&
                string.Equals(System.IO.Path.GetFileName(name), expected, StringComparison.OrdinalIgnoreCase);
        }

        private void OnFileName(string name)
        {
            if (IsTarget(name, "pet_config.json"))
            {
                _dispatcher.BeginInvoke(new Action(delegate
                {
                    if (_disposed) return;
                    ReloadPetConfig();
                    SyncPetWindow(false);
                    WriteStatusFile(true);
                }));
            }
            else if (IsTarget(name, "hud_telemetry.json"))
            {
                _dispatcher.BeginInvoke(new Action(delegate
                {
                    if (_disposed) return;
                    ReloadTelemetry();
                    if (_petWindow != null && _petWindow.Visibility == Visibility.Visible)
                    {
                        _petWindow.ApplyConfigAndTelemetry(_petConfig, _telemetry, _themePalette, false);
                    }
                }));
            }
            else if (IsTarget(name, "themes.json"))
            {
                _dispatcher.BeginInvoke(new Action(delegate
                {
                    if (_disposed) return;
                    ReloadThemePalette();
                    if (_petWindow != null && _petWindow.Visibility == Visibility.Visible)
                    {
                        _petWindow.ApplyConfigAndTelemetry(_petConfig, _telemetry, _themePalette, false);
                    }
                }));
            }
        }

        private void CheckFiles()
        {
            try
            {
                if (File.Exists(_petConfigPath))
                {
                    var fi = new FileInfo(_petConfigPath);
                    if (fi.LastWriteTimeUtc != _lastPetWriteUtc || fi.Length != _lastPetLen)
                    {
                        ReloadPetConfig();
                        SyncPetWindow(false);
                        WriteStatusFile(true);
                    }
                }
            }
            catch { }

            try
            {
                if (File.Exists(_hudTelemetryPath))
                {
                    var fi = new FileInfo(_hudTelemetryPath);
                    if (fi.LastWriteTimeUtc != _lastHudWriteUtc || fi.Length != _lastHudLen)
                    {
                        ReloadTelemetry();
                        if (_petWindow != null && _petWindow.Visibility == Visibility.Visible)
                        {
                            _petWindow.ApplyConfigAndTelemetry(_petConfig, _telemetry, _themePalette, false);
                        }
                    }
                }
            }
            catch { }

            try
            {
                if (File.Exists(_themesPath))
                {
                    var fi = new FileInfo(_themesPath);
                    if (fi.LastWriteTimeUtc != _lastThemeWriteUtc || fi.Length != _lastThemeLen)
                    {
                        ReloadThemePalette();
                        if (_petWindow != null && _petWindow.Visibility == Visibility.Visible)
                        {
                            _petWindow.ApplyConfigAndTelemetry(_petConfig, _telemetry, _themePalette, false);
                        }
                    }
                }
            }
            catch { }
        }

        private static string ReadTextRetry(string path)
        {
            for (int i = 0; i < 4; i++)
            {
                try
                {
                    using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    using (var sr = new StreamReader(fs, Encoding.UTF8, true))
                    {
                        return sr.ReadToEnd();
                    }
                }
                catch { Thread.Sleep(25); }
            }
            return "";
        }

        private static string ReadString(Dictionary<string, object> d, string key, string fallback)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v != null) return Convert.ToString(v, CultureInfo.InvariantCulture) ?? fallback;
            return fallback;
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
            if (d != null && d.TryGetValue(key, out v) && v != null)
            {
                try { return Convert.ToInt32(v, CultureInfo.InvariantCulture); } catch { }
            }
            return fallback;
        }

        private static long ReadLong(Dictionary<string, object> d, string key, long fallback)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v != null)
            {
                try { return Convert.ToInt64(v, CultureInfo.InvariantCulture); } catch { }
            }
            return fallback;
        }

        private static int? ReadNullableInt(Dictionary<string, object> d, string key)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v != null)
            {
                try { return Convert.ToInt32(v, CultureInfo.InvariantCulture); } catch { }
            }
            return null;
        }

        private static double? ReadNullableDouble(Dictionary<string, object> d, string key)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v != null)
            {
                try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); } catch { }
            }
            return null;
        }

        private static int ClampInt(int val, int min, int max)
        {
            return Math.Max(min, Math.Min(max, val));
        }

        private static List<CustomPetFrameRef> ParseFrames(object rawList)
        {
            var res = new List<CustomPetFrameRef>();
            if (rawList is System.Collections.IEnumerable && !(rawList is string))
            {
                foreach (object o in (System.Collections.IEnumerable)rawList)
                {
                    var d = o as Dictionary<string, object>;
                    if (d == null) continue;
                    string fn = System.IO.Path.GetFileName(ReadString(d, "filename", ""));
                    if (string.IsNullOrEmpty(fn)) continue;
                    res.Add(new CustomPetFrameRef { filename = fn, mime = ReadString(d, "mime", "image/png") });
                }
            }
            return res;
        }

        private static List<Dictionary<string, object>> SerializeFrames(List<CustomPetFrameRef> list)
        {
            var outList = new List<Dictionary<string, object>>();
            if (list == null) return outList;
            for (int i = 0; i < list.Count; i++)
            {
                if (list[i] == null || string.IsNullOrEmpty(list[i].filename)) continue;
                outList.Add(new Dictionary<string, object> { { "filename", list[i].filename }, { "mime", list[i].mime ?? "image/png" } });
            }
            return outList;
        }

        private void ReloadThemePalette()
        {
            try
            {
                if (!File.Exists(_themesPath)) return;
                var fi = new FileInfo(_themesPath);
                string raw = ReadTextRetry(_themesPath);
                if (string.IsNullOrEmpty(raw)) return;
                _lastThemeWriteUtc = fi.LastWriteTimeUtc;
                _lastThemeLen = fi.Length;
                var doc = _json.DeserializeObject(raw) as Dictionary<string, object>;
                if (doc == null) return;
                var next = new PetThemePalette
                {
                    radius = ClampInt(ReadInt(doc, "radius", 10), 4, 18)
                };
                object colorsObj;
                if (doc.TryGetValue("colors", out colorsObj))
                {
                    var colors = colorsObj as Dictionary<string, object>;
                    if (colors != null)
                    {
                        next.accent = ReadString(colors, "accent", next.accent);
                        next.contrast = ReadString(colors, "contrast", next.contrast);
                        next.tertiary = ReadString(colors, "tertiary", next.tertiary);
                        next.canvas = ReadString(colors, "canvas", next.canvas);
                        next.chrome = ReadString(colors, "chrome", next.chrome);
                        next.bubble = ReadString(colors, "bubble", next.bubble);
                    }
                }
                _themePalette = next;
            }
            catch { }
        }

        private void ReloadTelemetry()
        {
            try
            {
                if (!File.Exists(_hudTelemetryPath)) return;
                var fi = new FileInfo(_hudTelemetryPath);
                string raw = ReadTextRetry(_hudTelemetryPath);
                if (string.IsNullOrEmpty(raw)) return;
                _lastHudWriteUtc = fi.LastWriteTimeUtc;
                _lastHudLen = fi.Length;
                var doc = _json.DeserializeObject(raw) as Dictionary<string, object>;
                if (doc == null) return;
                _telemetry = new PetTelemetry
                {
                    percent = ClampInt(ReadInt(doc, "percent", 0), 0, 999),
                    tokPerSec = ReadNullableDouble(doc, "tokPerSec"),
                    cacheHitPct = ReadNullableInt(doc, "cacheHitPct"),
                    latestInputTokens = Math.Max(0L, ReadLong(doc, "latestInputTokens", 0L)),
                    latestOutputTokens = Math.Max(0L, ReadLong(doc, "latestOutputTokens", 0L)),
                    latestStepAtMs = Math.Max(0L, ReadLong(doc, "latestStepAtMs", 0L)),
                    upstreamModelId = ReadString(doc, "upstreamModelId", ""),
                    activeSessionCount = ClampInt(ReadInt(doc, "activeSessionCount", 0), 0, 999),
                    unreadSessionCount = ClampInt(ReadInt(doc, "unreadSessionCount", 0), 0, 999),
                    agentState = ReadString(doc, "agentState", "idle")
                };
            }
            catch { }
        }

        private void ReloadPetConfig()
        {
            try
            {
                if (!File.Exists(_petConfigPath))
                {
                    _petConfig = new PetConfig();
                    return;
                }
                var fi = new FileInfo(_petConfigPath);
                string raw = ReadTextRetry(_petConfigPath);
                if (string.IsNullOrEmpty(raw)) return;
                _lastPetWriteUtc = fi.LastWriteTimeUtc;
                _lastPetLen = fi.Length;
                var doc = _json.DeserializeObject(raw) as Dictionary<string, object>;
                if (doc == null) return;

                string petsDir = System.IO.Path.Combine(_dataDir, "pets");
                var next = new PetConfig
                {
                    enabled = ReadBool(doc, "enabled", false),
                    activePetId = ReadString(doc, "activePetId", "neko"),
                    displayMode = ReadString(doc, "displayMode", "auto"),
                    size = ClampInt(ReadInt(doc, "size", 100), 60, 500),
                    opacity = ClampInt(ReadInt(doc, "opacity", 95), 40, 100),
                    alwaysOnTop = ReadBool(doc, "alwaysOnTop", true),
                    showSpeechBubble = ReadBool(doc, "showSpeechBubble", true),
                    bubbleTemplate = ReadString(doc, "bubbleTemplate", "入 {in} · 出 {out}"),
                    autoWander = ReadBool(doc, "autoWander", true),
                    selectable = ReadBool(doc, "selectable", true),
                    posX = ReadNullableInt(doc, "posX"),
                    posY = ReadNullableInt(doc, "posY"),
                    petsDir = petsDir
                };

                object rawCustomObj;
                if (doc.TryGetValue("customPets", out rawCustomObj) && rawCustomObj is System.Collections.IEnumerable && !(rawCustomObj is string))
                {
                    foreach (object itemObj in (System.Collections.IEnumerable)rawCustomObj)
                    {
                        var cdoc = itemObj as Dictionary<string, object>;
                        if (cdoc == null) continue;
                        string cid = ReadString(cdoc, "id", "");
                        if (string.IsNullOrEmpty(cid)) continue;
                        string ckind = ReadString(cdoc, "kind", "image");
                        int cfps = ClampInt(ReadInt(cdoc, "fps", 8), 1, 30);

                        object rawFramesObj;
                        List<CustomPetFrameRef> frames = cdoc.TryGetValue("frames", out rawFramesObj) ? ParseFrames(rawFramesObj) : new List<CustomPetFrameRef>();
                        var sfMap = new Dictionary<string, List<CustomPetFrameRef>>();
                        object rawSfObj;
                        if (cdoc.TryGetValue("stateFrames", out rawSfObj))
                        {
                            var sfDict = rawSfObj as Dictionary<string, object>;
                            if (sfDict != null)
                            {
                                string[] tracks = new string[] { "running", "unread", "interact", "walk", "drag" };
                                for (int t = 0; t < tracks.Length; t++)
                                {
                                    object rawT;
                                    if (sfDict.TryGetValue(tracks[t], out rawT))
                                    {
                                        List<CustomPetFrameRef> tl = ParseFrames(rawT);
                                        if (tl.Count > 0) sfMap[tracks[t]] = tl;
                                    }
                                }
                            }
                        }

                        bool isFrames = string.Equals(ckind, "frames", StringComparison.OrdinalIgnoreCase) || frames.Count > 0;
                        string cfile = System.IO.Path.GetFileName(ReadString(cdoc, "filename", ""));
                        if (isFrames && string.IsNullOrEmpty(cfile) && frames.Count > 0) cfile = frames[0].filename;
                        if (string.IsNullOrEmpty(cfile)) continue;

                        next.customPets.Add(new CustomPetEntry
                        {
                            id = cid,
                            name = ReadString(cdoc, "name", cfile),
                            kind = isFrames ? "frames" : "image",
                            fps = cfps,
                            filename = cfile,
                            mime = ReadString(cdoc, "mime", "image/png"),
                            frames = frames,
                            stateFrames = sfMap
                        });
                    }
                }

                for (int i = 0; i < next.customPets.Count; i++)
                {
                    if (string.Equals(next.customPets[i].id, next.activePetId, StringComparison.Ordinal))
                    {
                        next.activeCustomPet = next.customPets[i];
                        string candidate = System.IO.Path.Combine(petsDir, next.customPets[i].filename);
                        if (File.Exists(candidate)) next.customImagePath = candidate;
                        break;
                    }
                }

                bool hadPos = _petConfig != null && (_petConfig.posX.HasValue || _petConfig.posY.HasValue);
                _petConfig = next;
                if (hadPos && !_petConfig.posX.HasValue && !_petConfig.posY.HasValue && _petWindow != null)
                {
                    _petWindow.ApplyConfigAndTelemetry(_petConfig, _telemetry, _themePalette, true);
                }
            }
            catch { }
        }

        private void SavePetConfigToDisk()
        {
            try
            {
                var customList = new List<Dictionary<string, object>>();
                if (_petConfig.customPets != null)
                {
                    for (int i = 0; i < _petConfig.customPets.Count; i++)
                    {
                        CustomPetEntry cp = _petConfig.customPets[i];
                        if (cp == null || string.IsNullOrEmpty(cp.id)) continue;
                        var dict = new Dictionary<string, object>
                        {
                            { "id", cp.id },
                            { "name", cp.name ?? cp.id },
                            { "kind", string.Equals(cp.kind, "frames", StringComparison.OrdinalIgnoreCase) ? "frames" : "image" },
                            { "filename", cp.filename ?? "" },
                            { "mime", cp.mime ?? "image/png" },
                            { "builtin", false }
                        };
                        if (string.Equals(cp.kind, "frames", StringComparison.OrdinalIgnoreCase))
                        {
                            dict["fps"] = ClampInt(cp.fps, 1, 30);
                            dict["frames"] = SerializeFrames(cp.frames);
                            var sfOut = new Dictionary<string, object>();
                            if (cp.stateFrames != null)
                            {
                                foreach (KeyValuePair<string, List<CustomPetFrameRef>> kv in cp.stateFrames)
                                {
                                    if (kv.Value != null && kv.Value.Count > 0) sfOut[kv.Key] = SerializeFrames(kv.Value);
                                }
                            }
                            dict["stateFrames"] = sfOut;
                        }
                        customList.Add(dict);
                    }
                }

                long nowMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                var payload = new Dictionary<string, object>
                {
                    { "version", 1 },
                    { "enabled", _petConfig.enabled },
                    { "activePetId", _petConfig.activePetId ?? "neko" },
                    { "customPets", customList },
                    { "displayMode", _petConfig.displayMode ?? "auto" },
                    { "size", _petConfig.size },
                    { "opacity", _petConfig.opacity },
                    { "alwaysOnTop", _petConfig.alwaysOnTop },
                    { "showSpeechBubble", _petConfig.showSpeechBubble },
                    { "bubbleTemplate", string.IsNullOrEmpty(_petConfig.bubbleTemplate) ? "入 {in} · 出 {out}" : _petConfig.bubbleTemplate },
                    { "autoWander", _petConfig.autoWander },
                    { "selectable", _petConfig.selectable },
                    { "posX", _petConfig.posX.HasValue ? (object)_petConfig.posX.Value : null },
                    { "posY", _petConfig.posY.HasValue ? (object)_petConfig.posY.Value : null },
                    { "updatedAt", nowMs }
                };
                AtomicWriteJson(_petConfigPath, payload);
                var fi = new FileInfo(_petConfigPath);
                _lastPetWriteUtc = fi.LastWriteTimeUtc;
                _lastPetLen = fi.Length;
            }
            catch { }
        }

        private void AtomicWriteJson(string targetPath, Dictionary<string, object> payload)
        {
            string tmp = targetPath + ".tmp";
            File.WriteAllText(tmp, _json.Serialize(payload), Utf8NoBom);
            try
            {
                if (File.Exists(targetPath)) File.Replace(tmp, targetPath, null);
                else File.Move(tmp, targetPath);
            }
            catch
            {
                File.Copy(tmp, targetPath, true);
                try { File.Delete(tmp); } catch { }
            }
        }

        private void SyncPetWindow(bool forcePosition)
        {
            if (_disposed) return;
            bool wantDesktop = _petConfig != null &&
                _petConfig.enabled &&
                !string.Equals(_petConfig.displayMode, "panel", StringComparison.OrdinalIgnoreCase);

            if (!wantDesktop)
            {
                ShutdownGracefully();
                return;
            }

            if (_petWindow == null)
            {
                var pet = new DesktopPetWindow();
                _petWindow = pet;
                pet.PositionCommitted += delegate(int px, int py)
                {
                    if (_disposed) return;
                    _petConfig.posX = px;
                    _petConfig.posY = py;
                    SavePetConfigToDisk();
                };
                pet.SelectPetRequested += delegate(string nextId)
                {
                    if (_disposed || string.IsNullOrEmpty(nextId)) return;
                    _petConfig.activePetId = nextId;
                    _petConfig.customImagePath = "";
                    _petConfig.activeCustomPet = null;
                    string petsDir = System.IO.Path.Combine(_dataDir, "pets");
                    _petConfig.petsDir = petsDir;
                    if (_petConfig.customPets != null)
                    {
                        for (int i = 0; i < _petConfig.customPets.Count; i++)
                        {
                            if (string.Equals(_petConfig.customPets[i].id, nextId, StringComparison.Ordinal))
                            {
                                _petConfig.activeCustomPet = _petConfig.customPets[i];
                                string candidate = System.IO.Path.Combine(petsDir, _petConfig.customPets[i].filename);
                                if (File.Exists(candidate)) _petConfig.customImagePath = candidate;
                                break;
                            }
                        }
                    }
                    SavePetConfigToDisk();
                    SyncPetWindow(false);
                    WriteStatusFile(true);
                };
                pet.ToggleBubbleRequested += delegate(bool nextVal)
                {
                    if (_disposed) return;
                    _petConfig.showSpeechBubble = nextVal;
                    SavePetConfigToDisk();
                    SyncPetWindow(false);
                };
                pet.ToggleTopmostRequested += delegate(bool nextVal)
                {
                    if (_disposed) return;
                    _petConfig.alwaysOnTop = nextVal;
                    SavePetConfigToDisk();
                    SyncPetWindow(false);
                };
                pet.ToggleWanderRequested += delegate(bool nextVal)
                {
                    if (_disposed) return;
                    _petConfig.autoWander = nextVal;
                    SavePetConfigToDisk();
                    SyncPetWindow(false);
                };
                pet.ToggleSelectableRequested += delegate(bool nextVal)
                {
                    if (_disposed) return;
                    _petConfig.selectable = nextVal;
                    SavePetConfigToDisk();
                    SyncPetWindow(false);
                };
                pet.ChangeSizeRequested += delegate(int nextSize)
                {
                    if (_disposed) return;
                    _petConfig.size = ClampInt(nextSize, 60, 500);
                    SavePetConfigToDisk();
                    SyncPetWindow(false);
                };
                pet.ResetPositionRequested += delegate
                {
                    if (_disposed) return;
                    _petConfig.posX = null;
                    _petConfig.posY = null;
                    SavePetConfigToDisk();
                    SyncPetWindow(true);
                };
                pet.ClosePetRequested += delegate
                {
                    if (_disposed) return;
                    _petConfig.enabled = false;
                    SavePetConfigToDisk();
                    ShutdownGracefully();
                };
                pet.ApplyConfigAndTelemetry(_petConfig, _telemetry, _themePalette, true);
                pet.Show();
                pet.SetAnimationRunning(true);
            }
            else
            {
                _petWindow.ApplyConfigAndTelemetry(_petConfig, _telemetry, _themePalette, forcePosition);
                if (_petWindow.Visibility != Visibility.Visible) _petWindow.Show();
                _petWindow.SetAnimationRunning(true);
            }
        }

        private void WriteStatusFile(bool running)
        {
            try
            {
                _lastStatusWriteUtc = DateTime.UtcNow;
                long epochMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                var payload = new Dictionary<string, object>
                {
                    { "pid", _selfPid },
                    { "running", running },
                    { "supportsPet", true },
                    { "petEnabled", _petConfig != null && _petConfig.enabled },
                    { "petVisible", running && _petWindow != null && _petWindow.Visibility == Visibility.Visible },
                    { "updatedAtMs", epochMs }
                };
                AtomicWriteJson(_petStatusPath, payload);
            }
            catch { }
        }

        private void ShutdownGracefully()
        {
            Dispose();
            try
            {
                if (System.Windows.Application.Current != null)
                {
                    System.Windows.Application.Current.Shutdown(0);
                }
            }
            catch { }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try { if (_pollTimer != null) _pollTimer.Stop(); } catch { }
            try { if (_watcher != null) _watcher.Dispose(); } catch { }
            if (_petWindow != null)
            {
                DesktopPetWindow closing = _petWindow;
                _petWindow = null;
                try { closing.SetAnimationRunning(false); } catch { }
                try { closing.Hide(); } catch { }
                try { closing.Close(); } catch { }
            }
            WriteStatusFile(false);
            try { if (_stopEvent != null) _stopEvent.Dispose(); } catch { }
        }
    }

    internal static class Program
    {
        private const string MutexName = @"Local\AgyDesktopPetSingleton";
        private const string StopEventName = @"Local\AgyDesktopPetStop";

        [STAThread]
        public static void Main(string[] args)
        {
            string dataDir = "";
            for (int i = 0; i < args.Length; i++)
            {
                if (string.Equals(args[i], "--probe-desktop", StringComparison.OrdinalIgnoreCase))
                {
                    Console.WriteLine(PetNative.GetDesktopName());
                    return;
                }
                if (string.Equals(args[i], "--stop", StringComparison.OrdinalIgnoreCase))
                {
                    try
                    {
                        EventWaitHandle ev = EventWaitHandle.OpenExisting(StopEventName);
                        ev.Set();
                        ev.Dispose();
                    }
                    catch { }
                    return;
                }
                if (string.Equals(args[i], "--data-dir", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    dataDir = args[++i];
                }
            }

            if (string.IsNullOrEmpty(dataDir))
            {
                dataDir = System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    ".gemini", "antigravity", "plugin_data", "agy-monitor");
            }

            bool createdNew;
            using (var mutex = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew) return;
                var app = new System.Windows.Application();
                app.ShutdownMode = ShutdownMode.OnExplicitShutdown;
                PetHostController controller = null;
                app.Startup += delegate
                {
                    controller = new PetHostController(dataDir, app.Dispatcher);
                    controller.Start();
                };
                app.Exit += delegate
                {
                    if (controller != null) controller.Dispose();
                };
                app.Run();
            }
        }
    }
}
