export interface User { id: string; username: string; name: string; role: 'admin' | 'member' }
export interface UserConfig { asr: boolean; ai: boolean; aliyunHost: string; aliyunModel: string; deepseekModel: string }
export interface Segment { id: string; time: number; text: string; marked: boolean }
export interface Analysis { id: string; created: string; text: string; final: boolean }
export interface Meeting {
  id: string; title: string; created: string; status: 'ready' | 'recording' | 'paused' | 'completed' | 'interrupted';
  bytes: number; nextSeq: number; context: string; terms: string; autoAnalyze: boolean;
  error: string; analyzedCount: number; segments: Segment[]; analyses: Analysis[]; interim?: { time: number; text: string } | null
}
