using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace MeetingCompanion;

// A separate process keeps Python/ONNX dependencies isolated from WinUI and sherpa.
public sealed class WhisperTranscriber : ILocalTranscriber
{
    private readonly Channel<byte[]> audio = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(600)
    { SingleReader = true, SingleWriter = false, FullMode = BoundedChannelFullMode.Wait });
    private readonly Process process;
    private readonly Task worker;
    private readonly Task<string> errors;
    private readonly TaskCompletionSource ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private volatile bool inputClosed;
    public event Action<string>? Partial;
    public event Action<TranscriptSegment>? Final;
    public event Action<Exception>? Failed;

    public static string PythonPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MeetingCompanion", "WhisperRuntime", "Scripts", "python.exe");
    public static string DefaultModelFolder
    {
        get
        {
            var installed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MeetingCompanion", "Models", "whisper-large-v3-turbo");
            if (File.Exists(Path.Combine(installed, "model.bin"))) return installed;
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MeetingCompanion", "Models", "whisper", "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo", "snapshots");
            return Directory.Exists(root) ? Directory.GetDirectories(root).FirstOrDefault(p => File.Exists(Path.Combine(p, "model.bin"))) ?? root : root;
        }
    }
    private WhisperTranscriber(string folder)
    {
        if (!File.Exists(PythonPath)) throw new FileNotFoundException("Whisper 本地运行环境尚未安装，请运行 scripts/Install-Whisper.ps1。", PythonPath);
        foreach (var file in new[] { "model.bin", "config.json", "tokenizer.json" })
            if (!File.Exists(Path.Combine(folder, file))) throw new FileNotFoundException($"Whisper 模型缺少 {file}，请检查设置中的模型目录。", file);
        var info = new ProcessStartInfo(PythonPath)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        info.ArgumentList.Add("-u");
        info.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "scripts", "whisper_worker.py"));
        info.ArgumentList.Add(folder);
        info.Environment["PYTHONUTF8"] = "1";
        info.Environment["PYTHONIOENCODING"] = "utf-8";
        info.Environment["HF_HUB_OFFLINE"] = "1";
        process = Process.Start(info) ?? throw new IOException("无法启动 Whisper 本地进程。");
        errors = process.StandardError.ReadToEndAsync();
        worker = RunAsync();
    }
    public static WhisperTranscriber Start(string folder) => new(folder);
    public Task WaitUntilReadyAsync() => ready.Task.WaitAsync(TimeSpan.FromMinutes(2));
    public static async Task<WhisperTranscriber> CreateAsync(string folder)
    {
        var transcriber = Start(folder);
        try { await transcriber.ready.Task.WaitAsync(TimeSpan.FromMinutes(2)); return transcriber; }
        catch
        {
            transcriber.audio.Writer.TryComplete();
            transcriber.KillWorker();
            await transcriber.worker;
            throw;
        }
    }
    public void Push(byte[] pcm)
    {
        if (!audio.Writer.TryWrite(pcm)) audio.Writer.TryComplete(new IOException("Whisper 处理跟不上录音，已停止转写；原始录音继续保存。"));
    }
    public void FlushSegment() => Push([]);
    public async Task CompleteAsync() { audio.Writer.TryComplete(); await worker; }
    private void KillWorker()
    {
        try { if (!process.HasExited) process.Kill(true); }
        catch (InvalidOperationException) { }
    }

    private async Task RunAsync()
    {
        var output = ReadOutputAsync();
        try
        {
            var input = process.StandardInput.BaseStream;
            await foreach (var pcm in audio.Reader.ReadAllAsync())
            {
                await input.WriteAsync(BitConverter.GetBytes(pcm.Length));
                if (pcm.Length > 0) await input.WriteAsync(pcm);
                await input.FlushAsync();
            }
            inputClosed = true;
            process.StandardInput.Close();
            await output.WaitAsync(TimeSpan.FromMinutes(2));
            await process.WaitForExitAsync();
            if (process.ExitCode != 0) throw new IOException("Whisper 本地转写进程异常结束。" + await errors);
        }
        catch (Exception ex)
        {
            ready.TrySetException(ex);
            audio.Writer.TryComplete();
            KillWorker();
            try { await output; } catch { }
            Failed?.Invoke(ex);
        }
        finally { process.Dispose(); }
    }
    private async Task ReadOutputAsync()
    {
        try
        {
            while (await process.StandardOutput.ReadLineAsync() is { } line)
            {
                using var message = JsonDocument.Parse(line);
                var root = message.RootElement;
                switch (root.GetProperty("type").GetString())
                {
                    case "ready": ready.TrySetResult(); break;
                    case "status": Partial?.Invoke(root.GetProperty("text").GetString() ?? ""); break;
                    case "final": Final?.Invoke(new TranscriptSegment(root.GetProperty("start").GetDouble(), root.GetProperty("text").GetString() ?? "")); break;
                    case "error": throw new IOException(root.GetProperty("text").GetString());
                }
            }
            if (!ready.Task.IsCompleted) throw new IOException("Whisper 未能加载。" + await errors);
            if (!inputClosed) throw new IOException("Whisper 本地进程提前结束。" + await errors);
        }
        catch (Exception ex)
        {
            ready.TrySetException(ex);
            audio.Writer.TryComplete(ex);
            throw;
        }
    }
}
