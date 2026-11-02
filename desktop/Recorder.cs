using NAudio.Wave;
namespace MeetingCompanion;

public sealed class Recorder
{
    private readonly object gate = new();
    private WaveInEvent? input;
    private WaveFileWriter? writer;
    private TaskCompletionSource<Exception?>? stopped;
    private bool paused;
    private long recordedBytes;
    public event Action<double>? LevelChanged;
    public event Action<Exception?>? RecordingEnded;
    public event Action<byte[]>? AudioAvailable;
    public bool IsActive { get { lock (gate) return input != null; } }
    public bool IsPaused { get { lock (gate) return paused; } }
    public TimeSpan Duration { get { lock (gate) return TimeSpan.FromSeconds(recordedBytes / 32000d); } }
    public static string[] Devices() => Enumerable.Range(0, WaveIn.DeviceCount).Select(i => WaveIn.GetCapabilities(i).ProductName).ToArray();

    public void Start(int device, string path)
    {
        lock (gate)
        {
            if (input != null) throw new InvalidOperationException("已有录音进行中。");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var capture = new WaveInEvent { DeviceNumber = device, WaveFormat = new WaveFormat(16000, 16, 1), BufferMilliseconds = 100 };
            try
            {
                writer = new WaveFileWriter(path, capture.WaveFormat);
                input = capture;
                paused = false;
                recordedBytes = 0;
                stopped = new(TaskCreationOptions.RunContinuationsAsynchronously);
                capture.DataAvailable += OnData;
                capture.RecordingStopped += OnStopped;
                capture.StartRecording();
            }
            catch
            {
                capture.Dispose(); input = null; writer?.Dispose(); writer = null;
                throw;
            }
        }
    }
    private void OnData(object? sender, WaveInEventArgs e)
    {
        double peak = 0;
        lock (gate)
        {
            if (writer == null || paused) return;
            writer.Write(e.Buffer, 0, e.BytesRecorded);
            recordedBytes += e.BytesRecorded;
            // Update WAV headers as data arrives so a crash leaves a recoverable file.
            writer.Flush();
            for (var i = 0; i + 1 < e.BytesRecorded; i += 2)
                peak = Math.Max(peak, Math.Abs((double)BitConverter.ToInt16(e.Buffer, i)) / 32768d);
        }
        LevelChanged?.Invoke(peak * 100);
        AudioAvailable?.Invoke(e.Buffer.AsSpan(0, e.BytesRecorded).ToArray());
    }
    private void OnStopped(object? sender, StoppedEventArgs e)
    {
        Exception? error = e.Exception;
        lock (gate)
        {
            try { writer?.Dispose(); } catch (Exception ex) { error ??= ex; }
            writer = null; input?.Dispose(); input = null;
            stopped?.TrySetResult(error);
        }
        RecordingEnded?.Invoke(error);
    }
    public void TogglePause() { lock (gate) { if (input != null) paused = !paused; } }
    public Task<Exception?> StopAsync()
    {
        lock (gate)
        {
            if (input == null) return Task.FromResult<Exception?>(null);
            input.StopRecording();
            return stopped!.Task;
        }
    }
}
