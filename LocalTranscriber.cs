using System.Threading.Channels;
using SherpaOnnx;
namespace MeetingCompanion;

public record TranscriptSegment(double StartSeconds, string Text);

// All native recognizer operations run on a single worker, never on the audio callback.
public sealed class LocalTranscriber
{
    private readonly Channel<byte[]> audio = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(600) { SingleReader = true, SingleWriter = true, FullMode = BoundedChannelFullMode.Wait });
    private readonly OnlineRecognizer recognizer;
    private readonly OnlineStream stream;
    private readonly Task worker;
    private double seconds;
    private double segmentStart;
    public event Action<string>? Partial;
    public event Action<TranscriptSegment>? Final;
    public event Action<Exception>? Failed;

    public LocalTranscriber(string folder)
    {
        foreach (var file in new[] { "encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt" })
            if (!File.Exists(Path.Combine(folder, file))) throw new FileNotFoundException($"本地转写模型缺失：{Path.Combine(folder, file)}。请在设置中选择完整模型目录。", file);
        var config = new OnlineRecognizerConfig();
        config.FeatConfig.SampleRate = 16000;
        config.FeatConfig.FeatureDim = 80;
        config.ModelConfig.Paraformer.Encoder = Path.Combine(folder, "encoder.int8.onnx");
        config.ModelConfig.Paraformer.Decoder = Path.Combine(folder, "decoder.int8.onnx");
        config.ModelConfig.Tokens = Path.Combine(folder, "tokens.txt");
        config.ModelConfig.Provider = "cpu";
        config.ModelConfig.NumThreads = 2;
        config.DecodingMethod = "greedy_search";
        config.EnableEndpoint = 1;
        config.Rule1MinTrailingSilence = 2.4f;
        config.Rule2MinTrailingSilence = 1.2f;
        config.Rule3MinUtteranceLength = 20;
        recognizer = new OnlineRecognizer(config);
        try { stream = recognizer.CreateStream(); stream.AcceptWaveform(16000, new float[4800]); }
        catch { recognizer.Dispose(); throw; }
        worker = Task.Run(ProcessAsync);
    }

    public void Push(byte[] pcm)
    {
        if (!audio.Writer.TryWrite(pcm)) audio.Writer.TryComplete(new IOException("转写处理跟不上录音，已停止转写；本地录音继续保存。"));
    }
    public async Task CompleteAsync()
    {
        audio.Writer.TryComplete();
        await worker;
    }
    private async Task ProcessAsync()
    {
        try
        {
            await foreach (var pcm in audio.Reader.ReadAllAsync())
            {
                var samples = new float[pcm.Length / 2];
                for (var i = 0; i < samples.Length; i++) samples[i] = BitConverter.ToInt16(pcm, i * 2) / 32768f;
                stream.AcceptWaveform(16000, samples);
                seconds += samples.Length / 16000d;
                Decode();
                var text = recognizer.GetResult(stream).Text.Trim();
                Partial?.Invoke(text);
                if (recognizer.IsEndpoint(stream))
                {
                    Commit(text);
                    recognizer.Reset(stream);
                    stream.AcceptWaveform(16000, new float[4800]);
                    segmentStart = seconds;
                }
            }
            stream.AcceptWaveform(16000, new float[12800]);
            stream.InputFinished();
            Decode();
            Commit(recognizer.GetResult(stream).Text.Trim());
        }
        catch (Exception ex) { audio.Writer.TryComplete(); Failed?.Invoke(ex); }
        finally { stream.Dispose(); recognizer.Dispose(); }
    }
    private void Decode() { while (recognizer.IsReady(stream)) recognizer.Decode(stream); }
    private void Commit(string text)
    {
        if (!string.IsNullOrWhiteSpace(text)) Final?.Invoke(new TranscriptSegment(segmentStart, text));
        Partial?.Invoke("");
    }
}
