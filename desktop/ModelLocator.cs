namespace MeetingCompanion;

public static class ModelLocator
{
    public const string ModelName = "sherpa-onnx-streaming-paraformer-bilingual-zh-en";
    private static readonly string[] Required = ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"];
    public static bool IsComplete(string folder) => Required.All(file => File.Exists(Path.Combine(folder, file)));
    public static string Resolve(string? configured)
    {
        var preferred = Environment.ExpandEnvironmentVariables((configured ?? "").Trim().Trim('"'));
        var candidates = new[]
        {
            preferred,
            Path.Combine(preferred, ModelName),
            Path.Combine(AppContext.BaseDirectory, "Models", ModelName),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MeetingCompanion", "Models", ModelName),
            Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "", "MeetingCompanion", "Models", ModelName)
        };
        foreach (var folder in candidates)
            if (!string.IsNullOrWhiteSpace(folder) && IsComplete(folder)) return Path.GetFullPath(folder);
        throw new DirectoryNotFoundException($"找不到完整的本地转写模型。设置目录：{preferred}。需要 encoder.int8.onnx、decoder.int8.onnx 和 tokens.txt；请运行模型安装脚本或选择模型目录。");
    }
}
