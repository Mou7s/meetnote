using System.Text.Json;
using Windows.Security.Credentials;
namespace MeetingCompanion;

public sealed class AssistantSettings
{
    public string ModelFolder { get; set; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MeetingCompanion", "Models", "sherpa-onnx-streaming-paraformer-bilingual-zh-en");
    public string DeepSeekModel { get; set; } = "deepseek-flash";
    public bool AnalyzeAutomatically { get; set; }
    private static string SettingsFile => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MeetingCompanion", "settings.json");
    public static AssistantSettings Load() => File.Exists(SettingsFile) ? JsonSerializer.Deserialize<AssistantSettings>(File.ReadAllText(SettingsFile)) ?? new() : new();
    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(SettingsFile)!);
        File.WriteAllText(SettingsFile + ".tmp", JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(SettingsFile + ".tmp", SettingsFile, true);
    }
    public static string ReadKey()
    {
        try { var credential = new PasswordVault().Retrieve("MeetNote.DeepSeek", "api-key"); credential.RetrievePassword(); return credential.Password; }
        catch (System.Runtime.InteropServices.COMException) { return ""; }
    }
    public static void SaveKey(string key)
    {
        var vault = new PasswordVault();
        if (!string.IsNullOrWhiteSpace(key)) { vault.Add(new PasswordCredential("MeetNote.DeepSeek", "api-key", key)); return; }
        try { vault.Remove(vault.Retrieve("MeetNote.DeepSeek", "api-key")); }
        catch (System.Runtime.InteropServices.COMException) { }
    }
}
