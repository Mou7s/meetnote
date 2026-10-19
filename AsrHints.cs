namespace MeetingCompanion;

public static class AsrHints
{
    public static Dictionary<string, int> Vocabulary(string terms)
    {
        var words = terms.Split(['\r', '\n', ',', '，', ';', '；'], StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (words.Count > 50) throw new InvalidOperationException("专业词最多填写50个，请保留最重要、最容易识别错误的词。");
        return words.ToDictionary(word => word, _ => 3, StringComparer.OrdinalIgnoreCase);
    }
}
