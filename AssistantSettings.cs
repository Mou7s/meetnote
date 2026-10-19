using System.Text.Json;
using Windows.Security.Credentials;
namespace MeetingCompanion;

public sealed class AssistantSettings
{
    public string ModelFolder { get; set; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MeetingCompanion", "Models", "sherpa-onnx-streaming-paraformer-bilingual-zh-en");
    public string TranscriptionEngine { get; set; } = "aliyun";
    public string RecognitionContext { get; set; } = "";
    public string RecognitionTerms { get; set; } = "";
    public string CloudHost { get; set; } = "dashscope.aliyuncs.com";
    public string CloudModel { get; set; } = "qwen-audio-3.1-asr-flash-streaming";
    public string WhisperModelFolder { get; set; } = WhisperTranscriber.DefaultModelFolder;
    public string DeepSeekModel { get; set; } = "deepseek-flash";
    public bool AnalyzeAutomatically { get; set; } = true;
    private static string SettingsFile => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MeetingCompanion", "settings.json");
    public static AssistantSettings Load() => File.Exists(SettingsFile) ? JsonSerializer.Deserialize<AssistantSettings>(File.ReadAllText(SettingsFile)) ?? new() : new();
    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(SettingsFile)!);
        File.WriteAllText(SettingsFile + ".tmp", JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(SettingsFile + ".tmp", SettingsFile, true);
    }
    public static string ReadKey(string resource = "MeetNote.DeepSeek")
    {
        try { var credential = new PasswordVault().Retrieve(resource, "api-key"); credential.RetrievePassword(); return credential.Password; }
        catch (System.Runtime.InteropServices.COMException) { return ""; }
    }
    public static void SaveKey(string key, string resource = "MeetNote.DeepSeek")
    {
        var vault = new PasswordVault();
        if (!string.IsNullOrWhiteSpace(key)) { vault.Add(new PasswordCredential(resource, "api-key", key)); return; }
        try { vault.Remove(vault.Retrieve(resource, "api-key")); }
        catch (System.Runtime.InteropServices.COMException) { }
    }
}
