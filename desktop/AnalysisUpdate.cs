namespace MeetingCompanion;

public record AnalysisUpdate(DateTime CreatedAt, double StartSeconds, double EndSeconds, bool IsFinal, string Text);
