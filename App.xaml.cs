using Microsoft.UI.Xaml;
namespace MeetingCompanion;
public partial class App : Application
{
    private Window? window;
    public App()
    {
        UnhandledException += (_, args) => { Log(args.Exception); File.AppendAllText(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MeetingCompanion", "startup-error.txt"), "\nDetails: " + args.Message); };
        InitializeComponent();
    }
    private static void Log(Exception error)
    {
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MeetingCompanion");
        Directory.CreateDirectory(folder);
        File.WriteAllText(Path.Combine(folder, "startup-error.txt"), error.ToString());
    }
    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        try { window = new MainWindow(); window.Activate(); }
        catch (Exception error) { Log(error); throw; }
        if (Environment.GetCommandLineArgs().Contains("--check-transcriber"))
        {
            var report = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MeetingCompanion", "transcriber-check.txt");
            try
            {
                var result = await Task.Run(async () =>
                {
                    var folder = ModelLocator.Resolve(AssistantSettings.Load().ModelFolder);
                    var text = new System.Text.StringBuilder();
                    Exception? failure = null;
                    var transcriber = new LocalTranscriber(folder);
                    transcriber.Final += segment => text.AppendLine(segment.Text);
                    transcriber.Failed += error => failure = error;
                    using var wav = new NAudio.Wave.WaveFileReader(Path.Combine(folder, "test_wavs", "0.wav"));
                    var buffer = new byte[3200];
                    int count;
                    while ((count = wav.Read(buffer, 0, buffer.Length)) > 0) transcriber.Push(buffer.AsSpan(0, count).ToArray());
                    await transcriber.CompleteAsync();
                    if (failure != null) throw failure;
                    if (text.Length == 0) throw new IOException("未返回转写结果。");
                    return text.ToString();
                });
                File.WriteAllText(report, "PASS published WinUI process model loading and streaming recognition\n" + result);
            }
            catch (Exception error) { File.WriteAllText(report, "FAIL\n" + error); }
            finally { window?.Close(); }
        }
    }
}
