using System.Diagnostics;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Windowing;
namespace MeetingCompanion;

public partial class MainWindow : Window
{
    private readonly Recorder recorder = new();
    private readonly DispatcherTimer waveformTimer = new() { Interval = TimeSpan.FromMilliseconds(100) };
    private readonly Queue<double> waveformLevels = new();
    private long lastAudioTick;
    private double latestLevel;
    private long waveformStarted;

    private readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromSeconds(1) };
    private readonly string storage = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MeetingCompanion", "Meetings");
    private string? sessionFolder;
    private readonly List<string> marks = [];
    private bool stopping;
    private bool allowClose;
    private bool closePromptOpen;
    private bool starting;
    private bool transcriberLoading;
    private string? transcriptionError;
    private bool analyzing;
    private bool analysisScrollPending;
    private ILocalTranscriber? transcriber;
    private AssistantSettings settings = new();
    private string apiKey = "";
    private string cloudApiKey = "";
    private string analysis = "";
    private readonly List<AnalysisUpdate> analysisUpdates = [];
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
        try { settings = AssistantSettings.Load(); apiKey = AssistantSettings.ReadKey(); cloudApiKey = AssistantSettings.ReadKey("MeetNote.Aliyun"); }
        catch (Exception ex) { ShowNotice("无法读取设置", ex.Message, InfoBarSeverity.Warning); }
        TranscriptionEngine.SelectedIndex = settings.TranscriptionEngine == "aliyun" ? 0 : settings.TranscriptionEngine == "paraformer" ? 2 : 1;
        CloudApiKey.Password = cloudApiKey;
        CloudHost.Text = settings.CloudHost;
        RecognitionContext.Text = settings.RecognitionContext; RecognitionTerms.Text = settings.RecognitionTerms;
        CloudModel.SelectedIndex = settings.CloudModel == "qwen-audio-3.1-asr-flash-streaming" ? 2 : settings.CloudModel == "fun-asr-realtime" ? 1 : 0;
        WhisperModelFolder.Text = settings.WhisperModelFolder;
        ModelFolder.Text = settings.ModelFolder; AiModel.Text = settings.DeepSeekModel;
        ApiKey.Password = apiKey; AutoAnalyze.IsOn = settings.AnalyzeAutomatically; LiveAnalyze.IsOn = settings.AnalyzeAutomatically;
        Microphones.ItemsSource = Recorder.Devices();
        if (Microphones.Items.Count > 0) Microphones.SelectedIndex = 0;
        else { StartButton.IsEnabled = false; ShowNotice("未发现麦克风", "连接麦克风后重新打开应用。", InfoBarSeverity.Warning); }
        recorder.LevelChanged += level =>
        {
            Interlocked.Exchange(ref latestLevel, level);
            Interlocked.Exchange(ref lastAudioTick, Environment.TickCount64);
        };
        waveformTimer.Tick += (_, _) => UpdateWaveform();
        ResetWaveform("等待录音");
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
            if (transcriber is CloudTranscriber cloud)
                TransferStatus.Text = $"已发送 {cloud.SentDuration:hh\\:mm\\:ss} · 待发送 {cloud.PendingSeconds:F1} 秒";
            if (DateTime.UtcNow >= nextAnalysis)
            {
                nextAnalysis = DateTime.UtcNow.AddSeconds(5);
                SaveMetadata();
                if (settings.AnalyzeAutomatically && !stopping && !analyzing) analysisTask = AnalyzeAsync(false);
            }
        };
        Navigation.SelectedItem = Navigation.MenuItems[0];
        AppWindow.Closing += OnClosing;
        Closed += (_, _) => { waveformTimer.Stop(); lifetime.Cancel(); };
    }
    private void ResetWaveform(string status)
    {
        Interlocked.Exchange(ref lastAudioTick, 0);
        Interlocked.Exchange(ref latestLevel, 0);
        waveformLevels.Clear();
        AudioStatus.Text = status;
        DrawWaveform();
    }
    private void UpdateWaveform()
    {
        if (!recorder.IsActive || recorder.IsPaused || stopping) return;
        var tick = Interlocked.Read(ref lastAudioTick);
        var fresh = tick != 0 && Environment.TickCount64 - tick < 1000;
        var level = fresh ? Interlocked.CompareExchange(ref latestLevel, 0, 0) / 100d : 0;
        waveformLevels.Enqueue(Math.Clamp(level, 0, 1));
        while (waveformLevels.Count > 80) waveformLevels.Dequeue();
        AudioStatus.Text = !fresh
            ? Environment.TickCount64 - waveformStarted < 1500 ? "等待麦克风数据…" : "未收到音频 · 请检查麦克风"
            : level < 0.005 ? "正在采集 · 声音很轻或静音" : "正在采集 · 检测到声音";
        DrawWaveform();
    }
    private void OnWaveformSizeChanged(object sender, SizeChangedEventArgs e) => DrawWaveform();
    private void DrawWaveform()
    {
        if (Waveform == null || WaveformHost == null) return;
        var width = WaveformHost.ActualWidth;
        if (width <= 0) return;
        var points = new Microsoft.UI.Xaml.Media.PointCollection();
        var levels = waveformLevels.ToArray();
        // Eight seconds of real 100 ms peak envelopes, mirrored around the baseline.
        // Square-root scaling makes quiet input visible without animating silence.
        var offset = 80 - levels.Length;
        points.Add(new Windows.Foundation.Point(0, 32));
        for (var i = 0; i < 80; i++)
        {
            var amplitude = i < offset ? 0 : Math.Sqrt(levels[i - offset]) * 29;
            points.Add(new Windows.Foundation.Point((i + 0.25) / 80 * width, 32 - amplitude));
            points.Add(new Windows.Foundation.Point((i + 0.75) / 80 * width, 32 + amplitude));
        }
        points.Add(new Windows.Foundation.Point(width, 32));
        Waveform.Points = points;
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
        ResummarizeButton.IsEnabled = AnalyzeButton.IsEnabled = transcript.Count > 0 && !analyzing && !stopping && !starting && !string.IsNullOrWhiteSpace(apiKey);
        PauseButton.Content = recorder.IsPaused ? "继续" : "暂停";
        var modelName = settings.TranscriptionEngine == "aliyun" ? $"在线转写 · {settings.CloudModel}" : settings.TranscriptionEngine == "paraformer" ? "Paraformer" : "Whisper large-v3-turbo";
        RecordingStatus.Text = active ? recorder.IsPaused ? "录音已暂停" : transcriberLoading ? "正在录音 · 模型加载中 · 本地保存" : $"正在录音 · {modelName} · 本地保存" : $"准备就绪 · {modelName}";
    }
    private async void OnStart(object sender, RoutedEventArgs e)
    {
        starting = true; transcriptionError = null; UpdateButtons();
        try
        {
            AnalysisStatus.Text = settings.TranscriptionEngine == "aliyun" ? "准备在线语音转写…" : "正在加载本地模型…";
            transcriberLoading = false;
            if (settings.TranscriptionEngine == "aliyun")
            {
                transcriber = new CloudTranscriber(cloudApiKey, settings.CloudModel, settings.CloudHost, settings.RecognitionContext, settings.RecognitionTerms);
            }
            else if (settings.TranscriptionEngine == "paraformer")
            {
                var resolvedFolder = ModelLocator.Resolve(settings.ModelFolder);
                settings.ModelFolder = resolvedFolder; ModelFolder.Text = resolvedFolder;
                transcriber = await Task.Run(() => new LocalTranscriber(resolvedFolder));
            }
            else
            {
                transcriber = WhisperTranscriber.Start(settings.WhisperModelFolder);
                transcriberLoading = true;
            }
            transcriber.Partial += text => DispatcherQueue.TryEnqueue(() => PartialText.Text = text);
            transcriber.Final += segment => DispatcherQueue.TryEnqueue(() =>
            {
                transcript.Add(segment);
                TranscriptText.Text = string.Join("\n\n", transcript.Select(FormatSegment));
                TranscriptScroll.ChangeView(null, TranscriptScroll.ScrollableHeight, null);
                SaveMetadata(); UpdateButtons();
            });
            transcriber.Failed += ex => DispatcherQueue.TryEnqueue(() =>
            {
                transcriberLoading = false;
                transcriptionError = ex.Message;
                PartialText.Text = "转写未能继续，原始录音仍在本地保存。";
                UpdateButtons();
                ShowNotice("转写停止", ex.Message, InfoBarSeverity.Error);
            });
            transcript.Clear(); analyzedCount = 0; analysis = ""; analysisUpdates.Clear(); AnalysisHistory.Children.Clear(); AnalysisDraftHeading.Text = ""; TransferStatus.Text = "";
            TranscriptText.Text = ""; PartialText.Text = ""; AnalysisText.Text = "等待已确认的转写内容…";
            AnalysisStatus.Text = string.IsNullOrWhiteSpace(apiKey) ? "请在设置中填写 DeepSeek 密钥" : settings.AnalyzeAutomatically ? "自动分析已开启" : "自动分析关闭，可开启实时 AI 分析";
            nextAnalysis = DateTime.UtcNow;
            sessionFolder = Path.Combine(storage, DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N")[..6]);
            ResetWaveform("等待麦克风数据…");
            waveformStarted = Environment.TickCount64;
            recorder.Start(Microphones.SelectedIndex, Path.Combine(sessionFolder, "recording.wav"));
            marks.Clear(); Markers.Items.Clear(); Elapsed.Text = "00:00:00";
            FileLocation.Text = Path.Combine(sessionFolder, "recording.wav");
            var saved = SaveMetadata(); timer.Start(); waveformTimer.Start(); UpdateButtons();
            if (transcriber is WhisperTranscriber whisper)
            {
                PartialText.Text = "正在加载 Whisper，录音已开始并保存在本地…";
                _ = ObserveWhisperReadyAsync(whisper);
            }
            if (saved) ShowNotice(settings.TranscriptionEngine == "aliyun" ? "录音已开始，正在连接在线转写" : transcriberLoading ? "录音已开始，模型加载中" : "录音与转写已开始", settings.TranscriptionEngine == "aliyun" ? "麦克风音频会发送至阿里云识别；原始录音同时保存在本地。" : settings.TranscriptionEngine == "paraformer" ? "音频在本机识别并保存；暂停期间不录音、不转写。" : "录音已在本地保存；模型加载完成后会处理已采集的声音。", InfoBarSeverity.Success);
        }
        catch (Exception ex)
        {
            if (transcriber != null) { await transcriber.CompleteAsync(); transcriber = null; }
            transcriberLoading = false;
            AnalysisStatus.Text = "启动失败"; ShowNotice("无法开始录音", ex.Message, InfoBarSeverity.Error);
        }
        finally { starting = false; UpdateButtons(); }
    }
    private async Task ObserveWhisperReadyAsync(WhisperTranscriber instance)
    {
        try
        {
            await instance.WaitUntilReadyAsync();
            if (!ReferenceEquals(transcriber, instance) || !recorder.IsActive || stopping) return;
            transcriberLoading = false;
            PartialText.Text = "Whisper 已就绪，停顿后显示文字…";
            ShowNotice("录音与转写已开始", "Whisper 已加载，正在处理本地录音。", InfoBarSeverity.Success);
            UpdateButtons();
        }
        catch (Exception ex)
        {
            if (!ReferenceEquals(transcriber, instance)) return;
            transcriberLoading = false;
            ShowNotice("模型加载失败，录音仍在保存", ex.Message, InfoBarSeverity.Error);
            await instance.CompleteAsync();
            UpdateButtons();
        }
    }
    private void OnPause(object sender, RoutedEventArgs e)
    {
        recorder.TogglePause();
        if (recorder.IsPaused) transcriber?.FlushSegment();
        ResetWaveform(recorder.IsPaused ? "已暂停 · 不采集声音" : "等待麦克风数据…");
        waveformStarted = Environment.TickCount64;
        UpdateButtons();
    }
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
            var error = captureError ?? await recorder.StopAsync(); timer.Stop(); waveformTimer.Stop(); ResetWaveform("录音已结束");
            if (transcriber != null)
            {
                PartialText.Text = "正在保存最后的转写文字，请稍候…";
                await transcriber.CompleteAsync(); transcriber = null;
            }
            Elapsed.Text = recorder.Duration.ToString(@"hh\:mm\:ss");
            var saved = SaveMetadata();
            if (saved && transcriptionError != null && error == null)
                ShowNotice("录音已保存，转写不完整", transcriptionError, InfoBarSeverity.Warning);
            else if (saved) ShowNotice(error == null ? "录音与转写已保存" : "录音异常结束", error?.Message ?? FileLocation.Text, error == null ? InfoBarSeverity.Success : InfoBarSeverity.Error);
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
            var json = JsonSerializer.Serialize(new { title = MeetingTitle.Text, audio = "recording.wav", durationSeconds = recorder.Duration.TotalSeconds, recording = recorder.IsActive, transcriptionEngine = settings.TranscriptionEngine, cloudModel = settings.CloudModel, transcriptionError, markers = marks, transcript, analysis, analysisUpdates, analyzedSegments = analyzedCount }, new JsonSerializerOptions { WriteIndented = true });
            var destination = Path.Combine(sessionFolder, "meeting.json");
            File.WriteAllText(destination + ".tmp", json);
            File.Move(destination + ".tmp", destination, true);
            return true;
        }
        catch (Exception ex) { ShowNotice("会议信息保存失败", ex.Message, InfoBarSeverity.Error); return false; }
    }
    private static string FormatSegment(TranscriptSegment segment) => $"[{TimeSpan.FromSeconds(segment.StartSeconds):hh\\:mm\\:ss}] {segment.Text}";
    private async void OnAnalyze(object sender, RoutedEventArgs e) { analysisTask = AnalyzeAsync(false, true); await analysisTask; }
    private async void OnResummarize(object sender, RoutedEventArgs e)
    {
        analysisTask = AnalyzeAsync(true, true, true);
        await analysisTask;
    }
    private async Task AnalyzeAsync(bool final, bool manual = false, bool replace = false)
    {
        if (analyzing || transcript.Count == 0 || string.IsNullOrWhiteSpace(apiKey)) return;
        if (!final && transcript.Count <= analyzedCount)
        {
            if (manual) AnalysisStatus.Text = "暂无新增转写，前面的分析已保留。";
            return;
        }
        analyzing = true; UpdateButtons(); AnalysisStatus.Text = replace ? "正在根据全部转写重新总结…" : final ? "正在生成最终总结…" : "正在分析…";
        try
        {
            var count = transcript.Count;
            // Completed batches remain immutable; only unanalysed speech forms a new batch.
            var pending = final ? transcript.ToList() : transcript.Skip(analyzedCount).ToList();
            var startSeconds = pending[0].StartSeconds;
            var endSeconds = pending[^1].StartSeconds;
            var heading = replace ? "会议重新总结" : final ? "会议最终总结" : $"新增分析 · {TimeSpan.FromSeconds(startSeconds):hh\\:mm\\:ss} — {TimeSpan.FromSeconds(endSeconds):hh\\:mm\\:ss}";
            AnalysisDraftHeading.Text = heading + "（生成中）";
            AnalysisText.Text = "";
            var context = replace ? "" : analysis.Length <= 24000 ? analysis : analysis[^24000..];
            var input = string.Join("\n", pending.Select(FormatSegment));
            if (input.Length > 60000) throw new InvalidOperationException("待分析内容过长，请及时分析或拆分会议；已有录音和转写仍保存在本地。");
            var generated = await analyzer.AnalyzeAsync(apiKey, settings.DeepSeekModel, MeetingTitle.Text, context, input, final, lifetime.Token, text =>
            {
                AnalysisText.Text = text;
                QueueAnalysisScroll();
                AnalysisStatus.Text = replace ? "重新总结生成中…" : final ? "正在生成最终总结…" : "实时更新中…";
            });
            var entry = new AnalysisUpdate(DateTime.Now, startSeconds, endSeconds, final, generated);
            if (replace)
            {
                analysisUpdates.Clear();
                AnalysisHistory.Children.Clear();
            }
            analysisUpdates.Add(entry);
            var block = new StackPanel { Spacing = 6 };
            block.Children.Add(new TextBlock { Text = heading, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
            block.Children.Add(new TextBlock { Text = generated, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true, FontSize = 16 });
            AnalysisHistory.Children.Add(block);
            analysis = string.Join("\n\n", analysisUpdates.Select(update => update.Text));
            analyzedCount = count;
            AnalysisText.Text = ""; AnalysisDraftHeading.Text = "";
            QueueAnalysisScroll();
            AnalysisStatus.Text = replace ? "重新总结已完成" : final ? "最终总结已完成" : $"已更新 · {DateTime.Now:HH:mm:ss}";
            SaveMetadata();
        }
        catch (Exception ex) { AnalysisText.Text = "本次分析未完成，可重试；之前的分析已保留。"; AnalysisDraftHeading.Text = ""; AnalysisStatus.Text = "分析失败，可点击立即分析重试"; ShowNotice("AI 分析失败", ex.Message, InfoBarSeverity.Error); }
        finally { analyzing = false; UpdateButtons(); }
    }
    private void QueueAnalysisScroll()
    {
        if (AnalysisScroll == null || FollowLatest?.IsChecked != true || analysisScrollPending) return;
        analysisScrollPending = true;
        DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, () =>
        {
            analysisScrollPending = false;
            if (FollowLatest.IsChecked == true)
                AnalysisScroll.ChangeView(null, AnalysisScroll.ScrollableHeight, null, true);
        });
    }
    private void OnAnalysisContentSizeChanged(object sender, SizeChangedEventArgs e) => QueueAnalysisScroll();
    private void OnFollowLatestChecked(object sender, RoutedEventArgs e) => QueueAnalysisScroll();
    private void OnLatestAnalysis(object sender, RoutedEventArgs e)
    {
        FollowLatest.IsChecked = true;
        QueueAnalysisScroll();
    }
    private void OnLiveAnalyzeChanged(object sender, RoutedEventArgs e)
    {
        if (LiveAnalyze == null || AutoAnalyze == null || AnalysisStatus == null) return;
        settings.AnalyzeAutomatically = LiveAnalyze.IsOn;
        AutoAnalyze.IsOn = LiveAnalyze.IsOn;
        nextAnalysis = DateTime.UtcNow;
        try { settings.Save(); }
        catch (Exception ex) { ShowNotice("自动分析设置未保存", ex.Message, InfoBarSeverity.Warning); }
        if (!analyzing)
            AnalysisStatus.Text = LiveAnalyze.IsOn ? string.IsNullOrWhiteSpace(apiKey) ? "请在设置中填写 DeepSeek 密钥" : "自动分析已开启，等待新增转写…" : "自动分析关闭，可点击立即分析";
    }
    private void OnSaveSettings(object sender, RoutedEventArgs e)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(ModelFolder.Text) || string.IsNullOrWhiteSpace(AiModel.Text)) throw new InvalidOperationException("请填写模型目录和 DeepSeek 模型名称。");
            AsrHints.Vocabulary(RecognitionTerms.Text);
            var updated = new AssistantSettings { RecognitionContext = RecognitionContext.Text.Trim(), RecognitionTerms = RecognitionTerms.Text.Trim(), TranscriptionEngine = TranscriptionEngine.SelectedIndex == 0 ? "aliyun" : TranscriptionEngine.SelectedIndex == 2 ? "paraformer" : "whisper", CloudHost = CloudHost.Text.Trim(), CloudModel = CloudModel.SelectedIndex == 2 ? "qwen-audio-3.1-asr-flash-streaming" : CloudModel.SelectedIndex == 1 ? "fun-asr-realtime" : "paraformer-realtime-v2", WhisperModelFolder = WhisperModelFolder.Text.Trim().Trim('"'), ModelFolder = ModelFolder.Text.Trim(), DeepSeekModel = AiModel.Text.Trim(), AnalyzeAutomatically = AutoAnalyze.IsOn };
            AssistantSettings.SaveKey(ApiKey.Password.Trim()); AssistantSettings.SaveKey(CloudApiKey.Password.Trim(), "MeetNote.Aliyun"); updated.Save();
            settings = updated; apiKey = ApiKey.Password.Trim(); cloudApiKey = CloudApiKey.Password.Trim(); LiveAnalyze.IsOn = settings.AnalyzeAutomatically; UpdateButtons();
            ShowNotice("设置已保存", "语音转写与 DeepSeek 配置已更新。", InfoBarSeverity.Success);
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
