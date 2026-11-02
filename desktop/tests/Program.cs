using MeetingCompanion;
using NAudio.Wave;
using System.Net;
using System.Text;
using System.Text.Json;

static void Require(bool condition, string message) { if (!condition) throw new Exception(message); }
if (args.Length > 0 && args[0] == "--analysis-stream")
{
    var chunks = new List<string>();
    var streamHandler = new StreamingHandler();
    var streamAnalyzer = new DeepSeekAnalyzer(new HttpClient(streamHandler));
    var text = await streamAnalyzer.AnalyzeAsync("test", "deepseek-flash", "", "", "新增内容", false, CancellationToken.None, chunks.Add);
    Require(text == "要点：明天交付。", "Stream text was lost");
    Require(chunks.Count == 2 && chunks[0] == "要点：" && chunks[1] == text, "Progress did not increment");
    using (var payload = JsonDocument.Parse(streamHandler.Body!)) Require(payload.RootElement.GetProperty("stream").GetBoolean(), "Streaming not enabled");
    streamHandler.Complete = false;
    try { await streamAnalyzer.AnalyzeAsync("test", "deepseek-flash", "", "", "", false, CancellationToken.None, _ => { }); throw new Exception("Truncated response accepted"); }
    catch (IOException) { }
    using var cancel = new CancellationTokenSource();
    cancel.Cancel();
    try { await streamAnalyzer.AnalyzeAsync("test", "deepseek-flash", "", "", "", false, cancel.Token, _ => { }); throw new Exception("Cancellation ignored"); }
    catch (OperationCanceledException) { }
    Console.WriteLine("PASS streamed incremental text, stream request flag, interrupted-stream rejection and cancellation. Mock responses only; no recorded audio or external API calls.");
    return;
}
if (args.Length > 0 && args[0] == "--cloud-protocol")
{
    long deadline = 0;
    for (var packet = 0; packet < 6000; packet++)
        deadline = CloudTranscriber.NextSendDeadline(deadline, deadline + 5, 3200);
    Require(deadline == 600000, "Per-packet overhead accumulated into ten-minute audio clock");
    Require(CloudTranscriber.NextSendDeadline(100, 10000, 3200) == 9900, "Network stall permits unbounded catch-up");
    using var start = JsonDocument.Parse(CloudTranscriber.StartMessage("test-task", "paraformer-realtime-v2"));
    Require(start.RootElement.GetProperty("header").GetProperty("action").GetString() == "run-task", "Missing run-task");
    var payload = start.RootElement.GetProperty("payload");
    Require(payload.GetProperty("parameters").GetProperty("sample_rate").GetInt32() == 16000, "Wrong sample rate");
    Require(payload.GetProperty("parameters").GetProperty("semantic_punctuation_enabled").GetBoolean(), "Missing semantic punctuation");
    using var fun = JsonDocument.Parse(CloudTranscriber.StartMessage("test-task", "fun-asr-realtime"));
    Require(!fun.RootElement.GetProperty("payload").GetProperty("parameters").TryGetProperty("heartbeat", out _), "Paraformer-only option sent to Fun-ASR");
    using var qwenStart = JsonDocument.Parse(CloudTranscriber.StartMessage("qwen-test", "qwen-audio-3.1-asr-flash-streaming"));
    var qwenParameters = qwenStart.RootElement.GetProperty("payload").GetProperty("parameters");
    Require(qwenParameters.GetProperty("vad_model").GetString() == "far_field_meeting_16k", "Qwen meeting VAD missing");
    Require(qwenParameters.GetProperty("heartbeat").GetBoolean(), "Qwen heartbeat missing");
    Require(!qwenParameters.TryGetProperty("semantic_punctuation_enabled", out _), "Unsupported Paraformer option sent to Qwen");
    using var hinted = JsonDocument.Parse(CloudTranscriber.StartMessage("hint-test", "qwen-audio-3.1-asr-flash-streaming", "技术会议", "Test-42\nTest-42，ABC Tech"));
    var hintedPayload = hinted.RootElement.GetProperty("payload");
    Require(hintedPayload.GetProperty("parameters").GetProperty("vocabulary").EnumerateObject().Count() == 2, "Vocabulary was not deduplicated");
    Require(hintedPayload.GetProperty("input").GetProperty("context")[0].GetProperty("content")[0].GetProperty("text").GetString() == "技术会议", "Recognition context missing");
    using var plain = JsonDocument.Parse(CloudTranscriber.StartMessage("plain", "fun-asr-realtime", "技术会议", "Test-42"));
    Require(!plain.RootElement.GetProperty("payload").GetProperty("parameters").TryGetProperty("vocabulary", out _), "Qwen-only vocabulary sent to other model");
    try { AsrHints.Vocabulary(string.Join("\n", Enumerable.Range(0, 51))); throw new Exception("Oversize vocabulary accepted"); }
    catch (InvalidOperationException) { }
    using var final = JsonDocument.Parse("""{"payload":{"output":{"sentence":{"begin_time":400,"end_time":null,"text":"测试文字","sentence_end":true,"heartbeat":false}}}}""");
    var sentence = CloudTranscriber.ParseSentence(final.RootElement, 12);
    Require(sentence is { Final: true, Text: "测试文字" } && Math.Abs(sentence.Value.Start - 12.4) < 0.0001, "Final result or resumed recording timestamp failed");
    using var heartbeat = JsonDocument.Parse("""{"payload":{"output":{"sentence":{"heartbeat":true}}}}""");
    Require(CloudTranscriber.ParseSentence(heartbeat.RootElement, 0) == null, "Heartbeat became transcript");
    using var finish = JsonDocument.Parse(CloudTranscriber.FinishMessage("test-task"));
    Require(finish.RootElement.GetProperty("header").GetProperty("task_id").GetString() == "test-task", "Finish task lost ID");
    try { _ = new CloudTranscriber("", "paraformer-realtime-v2"); throw new Exception("Missing key accepted"); }
    catch (InvalidOperationException) { }
    Console.WriteLine("PASS cloud task messages, model parameters, final text, pause timestamp offset, heartbeat and missing-key handling. No API calls or recorded audio.");
    return;
}
var folder = args.Length > 0 ? args[0] : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MeetingCompanion", "Models", "sherpa-onnx-streaming-paraformer-bilingual-zh-en");
var partials = new List<string>();
Require(ModelLocator.Resolve("\"" + folder + "\"") == Path.GetFullPath(folder), "Quoted model directory failed");
Require(ModelLocator.Resolve(Path.GetDirectoryName(folder)) == Path.GetFullPath(folder), "Parent model directory failed");
Require(ModelLocator.IsComplete(ModelLocator.Resolve("missing-model-directory")), "Installed model fallback failed");
Console.WriteLine("PASS model path normalization, parent directory and installed fallback");
var finals = new List<TranscriptSegment>();
Exception? failure = null;
var transcriber = new LocalTranscriber(folder);
transcriber.Partial += text => partials.Add(text);
transcriber.Final += segment => finals.Add(segment);
transcriber.Failed += error => failure = error;
using (var wav = new WaveFileReader(Path.Combine(folder, "test_wavs", "0.wav")))
{
    Require(wav.WaveFormat.SampleRate == 16000 && wav.WaveFormat.BitsPerSample == 16 && wav.WaveFormat.Channels == 1, "Unexpected test WAV format");
    var buffer = new byte[3200];
    int count;
    while ((count = wav.Read(buffer, 0, buffer.Length)) > 0) transcriber.Push(buffer.AsSpan(0, count).ToArray());
}
await transcriber.CompleteAsync();
await transcriber.CompleteAsync(); // Completing twice must not touch disposed native state.
Require(failure == null, $"Recognition failed: {failure}");
Require(partials.Any(t => t.Length > 0), "No partial transcript");
Console.WriteLine("Final transcript: " + string.Join(" / ", finals.Select(s => s.Text)));
Console.WriteLine("Last partial: " + partials.LastOrDefault(t => t.Length > 0));
Require(finals.Count > 0 && string.Join("", finals.Select(s => s.Text)).Contains("星期"), "No final phrase recognized");
var lastPartial = partials.Last(t => t.Length > 0);
Require(finals[^1].Text.StartsWith(lastPartial) && finals[^1].Text.Length > lastPartial.Length, "Completion did not flush pending recognition");
Require(finals.All(s => s.StartSeconds >= 0), "Invalid segment time");
Console.WriteLine("PASS native streaming + final flush: " + string.Join(" / ", finals.Select(s => s.Text)));
try { _ = new LocalTranscriber(Path.Combine(folder, "missing")); throw new Exception("Missing model accepted"); }
catch (FileNotFoundException) { Console.WriteLine("PASS missing model handling"); }

var handler = new FakeHandler();
var analyzer = new DeepSeekAnalyzer(new HttpClient(handler));
var result = await analyzer.AnalyzeAsync("test-key", "deepseek-flash", "测试会议", "已有摘要", "[00:00:03] 明天交付", false, CancellationToken.None);
Require(result == "测试分析", "Response parsing failed");
using (var payload = JsonDocument.Parse(handler.Body!))
{
    Require(payload.RootElement.GetProperty("thinking").GetProperty("type").GetString() == "disabled", "Thinking not disabled");
    Require(payload.RootElement.GetProperty("messages")[1].GetProperty("content").GetString()!.Contains("[00:00:03]"), "Lost timestamp");
}
Require(handler.Authorization == "Bearer test-key", "Missing authentication");
handler.Status = HttpStatusCode.Unauthorized;
try { await analyzer.AnalyzeAsync("test-key", "deepseek-flash", "", "", "测试", false, CancellationToken.None); throw new Exception("HTTP failure accepted"); }
catch (HttpRequestException ex) { Require(ex.Message.Contains("401"), "Lost HTTP status"); }
Console.WriteLine("PASS DeepSeek request, response and HTTP error handling (mock; no external API request)");

sealed class FakeHandler : HttpMessageHandler
{
    public string? Body, Authorization;
    public HttpStatusCode Status = HttpStatusCode.OK;
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Body = await request.Content!.ReadAsStringAsync(cancellationToken);
        Authorization = request.Headers.Authorization?.ToString();
        return new HttpResponseMessage(Status) { Content = new StringContent("{\"choices\":[{\"message\":{\"content\":\"测试分析\"}}]}", Encoding.UTF8, "application/json") };
    }
}

sealed class StreamingHandler : HttpMessageHandler
{
    public string? Body;
    public bool Complete = true;
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Body = await request.Content!.ReadAsStringAsync(cancellationToken);
        var first = "data: " + JsonSerializer.Serialize(new { choices = new[] { new { delta = new { content = "要点：" } } } });
        var second = "data: " + JsonSerializer.Serialize(new { choices = new[] { new { delta = new { content = "明天交付。" }, finish_reason = "stop" } } });
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(first + "\n\n" + second + "\n\n" + (Complete ? "data: [DONE]\n\n" : ""), Encoding.UTF8, "text/event-stream") };
    }
}
