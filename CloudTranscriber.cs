using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace MeetingCompanion;

public sealed class CloudTranscriber : ILocalTranscriber
{
    private readonly Channel<byte[]> audio = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(600)
    { SingleReader = true, SingleWriter = false, FullMode = BoundedChannelFullMode.Wait });
    private readonly string key;
    private readonly string model;
    private readonly string context;
    private readonly string terms;
    private readonly Uri endpoint;
    private readonly Task worker;
    private long capturedBytes;
    private long sentBytes;
    public TimeSpan SentDuration => TimeSpan.FromSeconds(Interlocked.Read(ref sentBytes) / 32000d);
    public double PendingSeconds => Math.Max(0, (Interlocked.Read(ref capturedBytes) - Interlocked.Read(ref sentBytes)) / 32000d);
    public event Action<string>? Partial;
    public event Action<TranscriptSegment>? Final;
    public event Action<Exception>? Failed;

    public CloudTranscriber(string apiKey, string modelName, string host = "dashscope.aliyuncs.com", string recognitionContext = "", string vocabulary = "")
    {
        if (string.IsNullOrWhiteSpace(apiKey)) throw new InvalidOperationException("请先在设置中填写阿里云百炼 API Key，再开始在线转写。");
        if (modelName is not ("paraformer-realtime-v2" or "fun-asr-realtime" or "qwen-audio-3.1-asr-flash-streaming")) throw new InvalidOperationException("请选择受支持的云端转写模型。");
        host = host.Trim();
        if (host != "dashscope.aliyuncs.com" && !System.Text.RegularExpressions.Regex.IsMatch(host, @"^ws-[a-z0-9]+\.cn-beijing\.maas\.aliyuncs\.com$"))
            throw new InvalidOperationException("请填写北京地域百炼 API Host，不能填写其他网站地址。");
        endpoint = new Uri($"wss://{host}/api-ws/v1/inference");
        AsrHints.Vocabulary(vocabulary);
        if (recognitionContext.Length > 400) throw new InvalidOperationException("会议背景最多 400 个字符。");
        key = apiKey; model = modelName; context = recognitionContext; terms = vocabulary;
        worker = Task.Run(RunAsync);
    }
    public static async Task CheckConnectionAsync(string key, string model, string host, string context = "", string terms = "")
    {
        var owner = new CloudTranscriber(key, model, host, context, terms);
        try
        {
            using var session = new Session(owner, 0);
            await session.StartAsync();
        }
        finally { await owner.CompleteAsync(); }
    }
    public void Push(byte[] pcm)
    {
        Interlocked.Add(ref capturedBytes, pcm.Length);
        if (!audio.Writer.TryWrite(pcm))
        {
            Interlocked.Add(ref capturedBytes, -pcm.Length);
            audio.Writer.TryComplete(new IOException("在线转写积压或已断开；本地原始录音继续保存。"));
        }
    }
    public void FlushSegment() => Push([]);
    public async Task CompleteAsync() { audio.Writer.TryComplete(); await worker; }

    // Keep an absolute audio clock: scheduler/send overhead must not extend every packet.
    // After a long network stall allow at most one packet of catch-up, avoiding a large burst.
    internal static long NextSendDeadline(long previous, long now, int bytes)
    {
        var duration = bytes / 32;
        return Math.Max(previous + duration, now - duration);
    }
    internal static string StartMessage(string id, string model, string context = "", string terms = "")
    {
        var parameters = new Dictionary<string, object> { ["format"] = "pcm", ["sample_rate"] = 16000 };
        if (model == "paraformer-realtime-v2")
        {
            parameters["language_hints"] = new[] { "zh" };
            parameters["semantic_punctuation_enabled"] = true;
            parameters["heartbeat"] = true;
        }
        if (model == "qwen-audio-3.1-asr-flash-streaming")
        {
            parameters["language_hints"] = new[] { "zh" };
            parameters["vad_model"] = "far_field_meeting_16k";
            parameters["heartbeat"] = true;
        }
        object input = new { };
        if (model == "qwen-audio-3.1-asr-flash-streaming")
        {
            var vocabulary = AsrHints.Vocabulary(terms);
            if (vocabulary.Count > 0) parameters["vocabulary"] = vocabulary;
            if (!string.IsNullOrWhiteSpace(context))
                input = new { context = new[] { new { role = "user", content = new[] { new { type = "input_text", text = context } } } } };
        }
        return JsonSerializer.Serialize(new { header = new { action = "run-task", task_id = id, streaming = "duplex" }, payload = new { task_group = "audio", task = "asr", function = "recognition", model, parameters, input } });
    }
    internal static string FinishMessage(string id) => JsonSerializer.Serialize(new { header = new { action = "finish-task", task_id = id, streaming = "duplex" }, payload = new { input = new { } } });
    internal static (string Text, bool Final, double Start)? ParseSentence(JsonElement root, double offset)
    {
        if (!root.TryGetProperty("payload", out var payload) || !payload.TryGetProperty("output", out var output) || !output.TryGetProperty("sentence", out var sentence)) return null;
        if (sentence.TryGetProperty("heartbeat", out var heartbeat) && heartbeat.ValueKind == JsonValueKind.True) return null;
        var text = sentence.GetProperty("text").GetString() ?? "";
        var start = sentence.TryGetProperty("begin_time", out var begin) && begin.ValueKind == JsonValueKind.Number && begin.TryGetDouble(out var ms) ? ms / 1000d : 0;
        return (text, sentence.TryGetProperty("sentence_end", out var end) && end.ValueKind == JsonValueKind.True, offset + start);
    }
    private async Task RunAsync()
    {
        Session? session = null;
        long bytes = 0;
        try
        {
            await foreach (var pcm in audio.Reader.ReadAllAsync())
            {
                if (pcm.Length == 0)
                {
                    if (session != null) { await session.FinishAsync(); session.Dispose(); session = null; }
                    continue;
                }
                if (session == null)
                {
                    Partial?.Invoke("正在连接在线语音识别，录音持续保存在本地…");
                    session = new Session(this, bytes / 32000d);
                    await session.StartAsync();
                    Partial?.Invoke("在线转写已连接，正在识别…");
                }
                await session.SendAudioAsync(pcm);
                bytes += pcm.Length;
                Interlocked.Add(ref sentBytes, pcm.Length);
            }
            if (session != null) await session.FinishAsync();
            Partial?.Invoke("");
        }
        catch (Exception ex)
        {
            audio.Writer.TryComplete();
            Failed?.Invoke(new IOException("在线转写失败，本地录音继续保存。" + ex.Message, ex));
        }
        finally { session?.Dispose(); }
    }
    private sealed class Session(CloudTranscriber owner, double offset) : IDisposable
    {
        private readonly ClientWebSocket socket = new();
        private readonly CancellationTokenSource lifetime = new();
        private readonly TaskCompletionSource started = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource finished = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly string id = Guid.NewGuid().ToString("N");
        private readonly HashSet<(double, string)> confirmed = [];
        private Task receive = Task.CompletedTask;
        private long nextSend;
        public async Task StartAsync()
        {
            socket.Options.SetRequestHeader("Authorization", "Bearer " + owner.key);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            timeout.CancelAfter(TimeSpan.FromSeconds(20));
            await socket.ConnectAsync(owner.endpoint, timeout.Token);
            receive = ReceiveAsync();
            await SendTextAsync(StartMessage(id, owner.model, owner.context, owner.terms));
            await started.Task.WaitAsync(TimeSpan.FromSeconds(20));
            nextSend = Environment.TickCount64;
        }
        public async Task SendAudioAsync(byte[] pcm)
        {
            var delay = nextSend - Environment.TickCount64;
            if (delay > 0) await Task.Delay(TimeSpan.FromMilliseconds(delay), lifetime.Token);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            timeout.CancelAfter(TimeSpan.FromSeconds(20));
            await socket.SendAsync(pcm.AsMemory(), WebSocketMessageType.Binary, true, timeout.Token);
            nextSend = NextSendDeadline(nextSend, Environment.TickCount64, pcm.Length);
        }
        private async Task SendTextAsync(string json)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            timeout.CancelAfter(TimeSpan.FromSeconds(20));
            await socket.SendAsync(Encoding.UTF8.GetBytes(json).AsMemory(), WebSocketMessageType.Text, true, timeout.Token);
        }
        public async Task FinishAsync()
        {
            await SendTextAsync(FinishMessage(id));
            await finished.Task.WaitAsync(TimeSpan.FromSeconds(30));
            await receive;
        }
        private async Task ReceiveAsync()
        {
            try
            {
                var buffer = new byte[8192];
                while (true)
                {
                    using var message = new MemoryStream();
                    ValueWebSocketReceiveResult part;
                    do
                    {
                        part = await socket.ReceiveAsync(buffer.AsMemory(), lifetime.Token);
                        if (part.MessageType == WebSocketMessageType.Close) throw new IOException("语音服务关闭了连接。");
                        message.Write(buffer, 0, part.Count);
                        if (message.Length > 1048576) throw new IOException("语音服务消息过长。");
                    } while (!part.EndOfMessage);
                    using var json = JsonDocument.Parse(message.ToArray());
                    var root = json.RootElement;
                    var header = root.GetProperty("header");
                    switch (header.GetProperty("event").GetString())
                    {
                        case "task-started": started.TrySetResult(); break;
                        case "task-finished": finished.TrySetResult(); return;
                        case "task-failed": throw new IOException(header.GetProperty("error_code").GetString() + ": " + header.GetProperty("error_message").GetString());
                        case "result-generated":
                            var sentence = ParseSentence(root, offset);
                            if (sentence is { } s)
                            {
                                if (s.Final)
                                {
                                    if (!string.IsNullOrWhiteSpace(s.Text) && confirmed.Add((s.Start, s.Text))) owner.Final?.Invoke(new TranscriptSegment(s.Start, s.Text));
                                    owner.Partial?.Invoke("");
                                }
                                else owner.Partial?.Invoke(s.Text);
                            }
                            break;
                    }
                }
            }
            catch (Exception ex)
            {
                started.TrySetException(ex);
                finished.TrySetException(ex);
                owner.audio.Writer.TryComplete(ex);
            }
        }
        public void Dispose() { lifetime.Cancel(); socket.Abort(); socket.Dispose(); lifetime.Dispose(); }
    }
}
