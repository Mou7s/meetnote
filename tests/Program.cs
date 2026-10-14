using MeetingCompanion;
using NAudio.Wave;
using System.Net;
using System.Text;
using System.Text.Json;

static void Require(bool condition, string message) { if (!condition) throw new Exception(message); }
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
