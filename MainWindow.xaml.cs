using System.Diagnostics;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Windowing;
namespace MeetingCompanion;

public partial class MainWindow : Window
{
    private readonly Recorder recorder = new();
    private readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromSeconds(1) };
    private readonly string storage = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MeetingCompanion", "Meetings");
    private string? sessionFolder;
    private readonly List<string> marks = [];
    private bool stopping;
    private bool allowClose;
    private bool closePromptOpen;
    private bool starting;
    private bool analyzing;
    private LocalTranscriber? transcriber;
    private AssistantSettings settings = new();
    private string apiKey = "";
    private string analysis = "";
    private readonly List<TranscriptSegment> transcript = [];
    private readonly DeepSeekAnalyzer analyzer = new();
    private int analyzedCount;
    private DateTime nextAnalysis;
    private Task analysisTask = Task.CompletedTask;
    private readonly CancellationTokenSource lifetime = new();
    public MainWindow()
    {
        InitializeComponent();
        Title = "MeetNote — 会议助手";
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        var scale = GetDpiForWindow(hwnd) / 96d;
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
        var width = (int)Math.Min(1280 * scale, area.Width * 0.9);
        var height = (int)Math.Min(860 * scale, area.Height * 0.9);
        AppWindow.MoveAndResize(new Windows.Graphics.RectInt32(area.X + (area.Width - width) / 2, area.Y + (area.Height - height) / 2, width, height));
        SystemBackdrop = new Microsoft.UI.Xaml.Media.MicaBackdrop();
        Directory.CreateDirectory(storage);
        StorageLocation.Text = storage;
        try { settings = AssistantSettings.Load(); apiKey = AssistantSettings.ReadKey(); }
        catch (Exception ex) { ShowNotice("无法读取设置", ex.Message, InfoBarSeverity.Warning); }
        ModelFolder.Text = settings.ModelFolder; AiModel.Text = settings.DeepSeekModel;
        ApiKey.Password = apiKey; AutoAnalyze.IsOn = settings.AnalyzeAutomatically;
        Microphones.ItemsSource = Recorder.Devices();
        if (Microphones.Items.Count > 0) Microphones.SelectedIndex = 0;
        else { StartButton.IsEnabled = false; ShowNotice("未发现麦克风", "连接麦克风后重新打开应用。", InfoBarSeverity.Warning); }
        recorder.LevelChanged += level => DispatcherQueue.TryEnqueue(() => Level.Value = level);
        recorder.AudioAvailable += pcm => transcriber?.Push(pcm);
        recorder.RecordingEnded += error => DispatcherQueue.TryEnqueue(async () =>
        {
            if (!stopping)
            {
                await FinishAsync(error);
            }
        });
        timer.Tick += (_, _) =>
        {
            Elapsed.Text = recorder.Duration.ToString(@"hh\:mm\:ss");
            if (DateTime.UtcNow >= nextAnalysis)
            {
                nextAnalysis = DateTime.UtcNow.AddSeconds(20);
                SaveMetadata();
                if (settings.AnalyzeAutomatically && !stopping && !analyzing) analysisTask = AnalyzeAsync(false);
            }
        };
        Navigation.SelectedItem = Navigation.MenuItems[0];
        AppWindow.Closing += OnClosing;
        Closed += (_, _) => lifetime.Cancel();
    }
    private void ShowNotice(string title, string message, InfoBarSeverity severity)
    { Notice.Title = title; Notice.Message = message; Notice.Severity = severity; Notice.IsOpen = true; }
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);
    private void UpdateButtons()
    {
        var active = recorder.IsActive;
        StartButton.IsEnabled = !active && !stopping && !starting && !analyzing && Microphones.Items.Count > 0;
        PauseButton.IsEnabled = MarkButton.IsEnabled = StopButton.IsEnabled = active && !stopping;
        Microphones.IsEnabled = MeetingTitle.IsEnabled = !active && !stopping && !starting && !analyzing;
        SaveSettingsButton.IsEnabled = !active && !stopping && !starting && !analyzing;
        AnalyzeButton.IsEnabled = transcript.Count > 0 && !analyzing && !stopping && !starting && !string.IsNullOrWhiteSpace(apiKey);
        PauseButton.Content = recorder.IsPaused ? "继续" : "暂停";
        RecordingStatus.Text = active ? recorder.IsPaused ? "录音已暂停" : "正在录音 · 本地保存" : "准备就绪";
    }
    private async void OnStart(object sender, RoutedEventArgs e)
    {
        starting = true; UpdateButtons();
        try
        {
            AnalysisStatus.Text = "正在加载本地模型…";
            var resolvedFolder = ModelLocator.Resolve(settings.ModelFolder);
            settings.ModelFolder = resolvedFolder; ModelFolder.Text = resolvedFolder;
            transcriber = await Task.Run(() => new LocalTranscriber(resolvedFolder));
            transcriber.Partial += text => DispatcherQueue.TryEnqueue(() => PartialText.Text = text);
            transcriber.Final += segment => DispatcherQueue.TryEnqueue(() =>
            {
                transcript.Add(segment);
                TranscriptText.Text = string.Join("\n\n", transcript.Select(FormatSegment));
                TranscriptScroll.ChangeView(null, TranscriptScroll.ScrollableHeight, null);
                SaveMetadata(); UpdateButtons();
            });
            transcriber.Failed += ex => DispatcherQueue.TryEnqueue(() => ShowNotice("本地转写停止", ex.Message, InfoBarSeverity.Error));
            transcript.Clear(); analyzedCount = 0; analysis = "";
            TranscriptText.Text = ""; PartialText.Text = ""; AnalysisText.Text = "等待已确认的转写内容…";
            AnalysisStatus.Text = string.IsNullOrWhiteSpace(apiKey) ? "请在设置中填写 DeepSeek 密钥" : settings.AnalyzeAutomatically ? "自动分析已开启" : "自动分析关闭，可点击立即分析";
            nextAnalysis = DateTime.UtcNow.AddSeconds(20);
            sessionFolder = Path.Combine(storage, DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N")[..6]);
            recorder.Start(Microphones.SelectedIndex, Path.Combine(sessionFolder, "recording.wav"));
            marks.Clear(); Markers.Items.Clear(); Elapsed.Text = "00:00:00";
            FileLocation.Text = Path.Combine(sessionFolder, "recording.wav");
            var saved = SaveMetadata(); timer.Start(); UpdateButtons();
            if (saved) ShowNotice("录音与转写已开始", "音频在本机识别并保存；暂停期间不录音、不转写。", InfoBarSeverity.Success);
        }
        catch (Exception ex)
        {
            if (transcriber != null) { await transcriber.CompleteAsync(); transcriber = null; }
            AnalysisStatus.Text = "启动失败"; ShowNotice("无法开始录音", ex.Message, InfoBarSeverity.Error);
        }
        finally { starting = false; UpdateButtons(); }
    }
    private void OnPause(object sender, RoutedEventArgs e) { recorder.TogglePause(); Level.Value = 0; UpdateButtons(); }
    private void OnMark(object sender, RoutedEventArgs e)
    {
        var mark = recorder.Duration.ToString(@"hh\:mm\:ss") + " · 重点";
        marks.Add(mark); Markers.Items.Add(mark); SaveMetadata();
    }
    private async void OnStop(object sender, RoutedEventArgs e) => await FinishAsync();
    private async Task FinishAsync(Exception? captureError = null)
    {
        if (stopping) return;
        stopping = true; UpdateButtons();
        try
        {
            var error = captureError ?? await recorder.StopAsync(); timer.Stop(); Level.Value = 0;
            if (transcriber != null) { await transcriber.CompleteAsync(); transcriber = null; }
            Elapsed.Text = recorder.Duration.ToString(@"hh\:mm\:ss");
            var saved = SaveMetadata();
            if (saved) ShowNotice(error == null ? "录音与转写已保存" : "录音异常结束", error?.Message ?? FileLocation.Text, error == null ? InfoBarSeverity.Success : InfoBarSeverity.Error);
            await analysisTask;
            if (settings.AnalyzeAutomatically && !string.IsNullOrWhiteSpace(apiKey)) await AnalyzeAsync(true);
        }
        catch (Exception ex) { ShowNotice("保存失败", ex.Message, InfoBarSeverity.Error); }
        finally { stopping = false; UpdateButtons(); }
    }
    private bool SaveMetadata()
    {
        if (sessionFolder == null || !Directory.Exists(sessionFolder)) return true;
        try
        {
            var json = JsonSerializer.Serialize(new { title = MeetingTitle.Text, audio = "recording.wav", durationSeconds = recorder.Duration.TotalSeconds, recording = recorder.IsActive, markers = marks, transcript, analysis, analyzedSegments = analyzedCount }, new JsonSerializerOptions { WriteIndented = true });
            var destination = Path.Combine(sessionFolder, "meeting.json");
            File.WriteAllText(destination + ".tmp", json);
            File.Move(destination + ".tmp", destination, true);
            return true;
        }
        catch (Exception ex) { ShowNotice("会议信息保存失败", ex.Message, InfoBarSeverity.Error); return false; }
    }
    private static string FormatSegment(TranscriptSegment segment) => $"[{TimeSpan.FromSeconds(segment.StartSeconds):hh\\:mm\\:ss}] {segment.Text}";
    private async void OnAnalyze(object sender, RoutedEventArgs e) { analysisTask = AnalyzeAsync(false, true); await analysisTask; }
    private async Task AnalyzeAsync(bool final, bool manual = false)
    {
        if (analyzing || transcript.Count == 0 || string.IsNullOrWhiteSpace(apiKey)) return;
        if (!final && !manual && transcript.Count <= analyzedCount) return;
        analyzing = true; UpdateButtons(); AnalysisStatus.Text = final ? "正在生成最终总结…" : "正在分析…";
        try
        {
            var count = transcript.Count;
            // Limit each update; the previous summary carries earlier context.
            var pending = transcript.Skip(analyzedCount).ToList();
            if (pending.Count == 0) pending = transcript.TakeLast(10).ToList();
            var input = string.Join("\n", pending.Select(FormatSegment));
            if (input.Length > 60000) throw new InvalidOperationException("待分析内容过长，请及时分析或拆分会议；已有录音和转写仍保存在本地。");
            analysis = await analyzer.AnalyzeAsync(apiKey, settings.DeepSeekModel, MeetingTitle.Text, analysis, input, final, lifetime.Token);
            analyzedCount = count; AnalysisText.Text = analysis;
            AnalysisStatus.Text = final ? "最终总结已完成" : $"已更新 · {DateTime.Now:HH:mm:ss}";
            SaveMetadata();
        }
        catch (Exception ex) { AnalysisStatus.Text = "分析失败，可点击立即分析重试"; ShowNotice("AI 分析失败", ex.Message, InfoBarSeverity.Error); }
        finally { analyzing = false; UpdateButtons(); }
    }
    private void OnSaveSettings(object sender, RoutedEventArgs e)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(ModelFolder.Text) || string.IsNullOrWhiteSpace(AiModel.Text)) throw new InvalidOperationException("请填写模型目录和 DeepSeek 模型名称。");
            var updated = new AssistantSettings { ModelFolder = ModelFolder.Text.Trim(), DeepSeekModel = AiModel.Text.Trim(), AnalyzeAutomatically = AutoAnalyze.IsOn };
            AssistantSettings.SaveKey(ApiKey.Password.Trim()); updated.Save();
            settings = updated; apiKey = ApiKey.Password.Trim(); UpdateButtons();
            ShowNotice("设置已保存", "本地转写与 DeepSeek 配置已更新。", InfoBarSeverity.Success);
        }
        catch (Exception ex) { ShowNotice("设置保存失败", ex.Message, InfoBarSeverity.Error); }
    }
    private void OnNavigationChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        if (args.SelectedItem is not NavigationViewItem item) return;
        var tag = item.Tag?.ToString();
        Workspace.Visibility = tag == "record" ? Visibility.Visible : Visibility.Collapsed;
        History.Visibility = tag == "history" ? Visibility.Visible : Visibility.Collapsed;
        Settings.Visibility = tag == "settings" ? Visibility.Visible : Visibility.Collapsed;
        Heading.Text = tag == "history" ? "会议记录" : tag == "settings" ? "设置" : "现场会议";
        if (tag == "history") History.ItemsSource = Directory.GetDirectories(storage).OrderByDescending(p => p).Select(Path.GetFileName).ToList();
    }
    private void OnHistorySelected(object sender, SelectionChangedEventArgs e)
    {
        if (History.SelectedItem is string folder) Process.Start(new ProcessStartInfo(Path.Combine(storage, folder)) { UseShellExecute = true });
    }
    private void OnOpenFolder(object sender, RoutedEventArgs e) => Process.Start(new ProcessStartInfo(storage) { UseShellExecute = true });
    private async void OnClosing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        if (allowClose) return;
        if (!recorder.IsActive && !stopping && !starting && !analyzing) return;
        args.Cancel = true;
        if (closePromptOpen || stopping || starting || analyzing) return;
        closePromptOpen = true;
        try
        {
            var dialog = new ContentDialog { XamlRoot = Navigation.XamlRoot, Title = "会议仍在录音", Content = "结束并保存录音后关闭窗口？", PrimaryButtonText = "结束并关闭", CloseButtonText = "继续录音", DefaultButton = ContentDialogButton.Close };
            if (await dialog.ShowAsync() == ContentDialogResult.Primary)
            { await FinishAsync(); if (!recorder.IsActive) { allowClose = true; Close(); } }
        }
        finally { closePromptOpen = false; }
    }
}
