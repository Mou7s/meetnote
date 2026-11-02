namespace MeetingCompanion;

public interface ILocalTranscriber
{
    event Action<string>? Partial;
    event Action<TranscriptSegment>? Final;
    event Action<Exception>? Failed;
    void Push(byte[] pcm);
    void FlushSegment() { }
    Task CompleteAsync();
}
