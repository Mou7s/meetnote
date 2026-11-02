import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'
import { HttpError, json } from './http'
import { connectAsr, type Asr } from './asr'
import { generateAnalysis } from './analysis'
import type { Meeting } from '../shared/types'
import { defaultSettings, type ProviderSettings } from './settings'

type Archive = { key: string; start: number; length: number }
type Chunk = { seq: number; start: number; bytes: ArrayBuffer }

export class MeetingRoom extends DurableObject<Env> {
  private asr: Asr | null = null
  private interim: { time: number; text: string } | null = null
  private changing = false
  private analyzing = false
  private flushing = false
  private tail: Promise<unknown> = Promise.resolve()
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS document (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, json TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (seq INTEGER PRIMARY KEY, start INTEGER NOT NULL, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS archives (key TEXT PRIMARY KEY, start INTEGER NOT NULL, length INTEGER NOT NULL);`)
    const saved = this.read()
    if (saved?.status === 'recording') {
      saved.status = 'interrupted'; saved.error = '实时会话已重启。已保存的录音仍可回放，转写可能不完整。'
      this.write(saved)
    }
  }
  private read(): Meeting | null {
    const rows = this.ctx.storage.sql.exec<{ json: string }>('SELECT json FROM document WHERE id=1').toArray()
    return rows[0] ? JSON.parse(rows[0].json) : null
  }
  private owner() { return this.ctx.storage.sql.exec<{ owner: string }>('SELECT owner FROM document WHERE id=1').one().owner }
  private write(meeting: Meeting) { this.ctx.storage.sql.exec('UPDATE document SET json=?,revision=revision+1 WHERE id=1', JSON.stringify(meeting)) }
  private assertOwner(owner: string) {
    if (!this.read() || this.owner() !== owner) throw new HttpError(404, '会议不存在')
  }
  private async index() {
    const meeting = this.read()!
    const { segments, analyses, ...rest } = meeting
    const summary = { ...rest, segmentCount: segments.length, analysisCount: analyses.length }
    const revision = this.ctx.storage.sql.exec<{ revision: number }>('SELECT revision FROM document').one().revision
    await this.env.DB.prepare('UPDATE meetings SET summary=?,revision=? WHERE id=? AND owner=? AND revision<=?')
      .bind(JSON.stringify(summary), revision, meeting.id, this.owner(), revision).run()
  }
  async initialize(owner: string, meeting: Meeting) {
    const current = this.read()
    if (current) { this.assertOwner(owner); return current }
    this.ctx.storage.sql.exec('INSERT INTO document VALUES(1,?,?,1)', owner, JSON.stringify(meeting))
    await this.index()
    return meeting
  }
  async detail(owner: string) { this.assertOwner(owner); return { ...this.read()!, interim: this.interim } }
  async mark(owner: string, segmentId: string) {
    this.assertOwner(owner)
    const meeting = this.read()!, segment = meeting.segments.find(s => s.id === segmentId)
    if (!segment) throw new HttpError(404, '转写段落不存在')
    segment.marked = !segment.marked; this.write(meeting); return meeting
  }
  async autoAnalyze(owner: string, enabled: boolean) {
    this.assertOwner(owner)
    const meeting = this.read()!; meeting.autoAnalyze = enabled; this.write(meeting); return meeting
  }
  private recordError(message = '在线转写中断，录音继续保存；本场转写不完整，请检查识别配置或网络。') {
    this.interim = null
    const meeting = this.read()!
    meeting.error = message
    this.write(meeting)
  }
  async state(owner: string, action: 'start' | 'pause' | 'resume' | 'stop', provider: ProviderSettings = defaultSettings()) {
    this.assertOwner(owner)
    if (this.changing) throw new HttpError(409, '会议状态正在更新')
    const meeting = this.read()!
    const valid = action === 'start' ? meeting.status === 'ready' : action === 'resume' ? ['paused', 'interrupted'].includes(meeting.status) : action === 'pause' ? meeting.status === 'recording' : ['recording', 'paused', 'interrupted'].includes(meeting.status)
    if (!valid) throw new HttpError(409, '当前会议状态不支持此操作')
    this.changing = true
    try {
      await this.tail
      if (action === 'start' || action === 'resume') {
        try {
          this.interim = null
          this.asr = await connectAsr(provider, meeting, (time, text, final) => {
            if (!final) { this.interim = { time, text }; return }
            this.interim = null
            const current = this.read()!
            if (!current.segments.some(s => s.time === time && s.text === text)) {
              current.segments.push({ id: crypto.randomUUID(), time, text, marked: false }); this.write(current)
            }
          }, () => this.recordError())
        } catch (error) { this.recordError(error instanceof Error ? error.message : undefined) }
        await this.ctx.storage.put('lastUpload', Date.now()); await this.ctx.storage.setAlarm(Date.now() + 120000)
      } else {
        await this.asr?.finish(); this.asr = null; this.interim = null
        await this.flush(true); await this.ctx.storage.deleteAlarm()
      }
      const current = this.read()!
      current.status = action === 'pause' ? 'paused' : action === 'stop' ? 'completed' : 'recording'
      if ((action === 'start' || action === 'resume') && !provider.ALIYUN_API_KEY) current.error = '你尚未配置百炼 API Key，本场仅录音。请在个人设置中填写自己的密钥。'
      this.write(current); await this.index(); return current
    } finally { this.changing = false }
  }
  async upload(owner: string, sequence: number, raw: ArrayBuffer) {
    this.assertOwner(owner)
    if (this.changing) throw new HttpError(409, '会议状态正在更新')
    const job = this.tail.then(async () => {
      const meeting = this.read()!
      if (meeting.status !== 'recording') throw new HttpError(409, '会议未处于录音状态')
      if (sequence < meeting.nextSeq) return { nextSeq: meeting.nextSeq, bytes: meeting.bytes }
      if (sequence !== meeting.nextSeq) throw new HttpError(409, '音频分块顺序不一致')
      if (!raw.byteLength || raw.byteLength > 128000 || raw.byteLength % 2) throw new HttpError(400, '无效 PCM16 分块')
      if (meeting.bytes + raw.byteLength > 230400000) throw new HttpError(413, '单场录音最多两小时')
      const staged = this.ctx.storage.sql.exec<{ size: number }>('SELECT COALESCE(SUM(length(bytes)),0) AS size FROM chunks').one().size
      if (staged > 8 * 1024 * 1024) throw new HttpError(503, '录音归档暂时失败，请保持页面打开后重试保存')
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('INSERT INTO chunks VALUES(?,?,?)', sequence, meeting.bytes, raw)
        meeting.bytes += raw.byteLength; meeting.nextSeq++; this.write(meeting)
      })
      await this.ctx.storage.put('lastUpload', Date.now())
      if (this.asr) this.ctx.waitUntil(this.asr.push(raw))
      if (staged + raw.byteLength >= 1024000 && !this.flushing) this.ctx.waitUntil(this.flush(false).catch(() => {}))
      return { nextSeq: meeting.nextSeq, bytes: meeting.bytes }
    })
    this.tail = job.catch(() => {})
    return job
  }
  private async flush(force: boolean) {
    if (this.flushing) {
      if (force) throw new HttpError(409, '正在归档录音，请稍后重试保存')
      return
    }
    const chunks = this.ctx.storage.sql.exec<Chunk>('SELECT seq,start,bytes FROM chunks ORDER BY seq').toArray()
    const size = chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0)
    if (!size || (!force && size < 1024000)) return
    this.flushing = true
    try {
      const bytes = new Uint8Array(size); let offset = 0
      for (const chunk of chunks) { bytes.set(new Uint8Array(chunk.bytes), offset); offset += chunk.bytes.byteLength }
      const meeting = this.read()!, start = chunks[0]!.start, last = chunks[chunks.length - 1]!.seq
      const key = `${this.owner()}/${meeting.id}/${start}.pcm`
      await this.env.RECORDINGS.put(key, bytes, { httpMetadata: { contentType: 'application/octet-stream' } })
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO archives VALUES(?,?,?)', key, start, size)
        this.ctx.storage.sql.exec('DELETE FROM chunks WHERE seq<=?', last)
      })
      await this.index()
    } finally { this.flushing = false }
  }
  override async alarm() {
    const meeting = this.read()
    if (!meeting || meeting.status !== 'recording') return
    const last = await this.ctx.storage.get<number>('lastUpload') || 0
    if (Date.now() - last < 110000) { await this.ctx.storage.setAlarm(last + 120000); return }
    this.asr?.close(); this.asr = null
    const current = this.read()!
    current.status = 'interrupted'; current.error = '录音上传已中断。已保存部分可回放，请检查浏览器或网络。'
    this.write(current); await this.flush(true); await this.index()
  }
  async audio(owner: string, range: string | null): Promise<Response> {
    this.assertOwner(owner)
    const meeting = this.read()!, size = meeting.bytes
    if (!size) throw new HttpError(404, '尚无已保存录音')
    const total = size + 44, header = new Uint8Array(44), data = new DataView(header.buffer), encoder = new TextEncoder()
    header.set(encoder.encode('RIFF')); data.setUint32(4, size + 36, true); header.set(encoder.encode('WAVEfmt '), 8)
    data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, 16000, true)
    data.setUint32(28, 32000, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true); header.set(encoder.encode('data'), 36); data.setUint32(40, size, true)
    let start = 0, end = total - 1
    const headers: Record<string, string> = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range)
      if (!match) throw new HttpError(416, '无效音频范围')
      start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end
      if (start > end || start >= total) throw new HttpError(416, '音频范围超出文件')
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`
    }
    headers['Content-Length'] = String(end - start + 1)
    const pcmStart = Math.max(0, start - 44), pcmEnd = end - 44
    const archives = this.ctx.storage.sql.exec<Archive>('SELECT * FROM archives WHERE start<=? AND start+length>? ORDER BY start', pcmEnd, pcmStart).toArray()
    const tail = this.ctx.storage.sql.exec<Chunk>('SELECT seq,start,bytes FROM chunks WHERE start<=? AND start+length(bytes)>? ORDER BY seq', pcmEnd, pcmStart).toArray()
    const bucket = this.env.RECORDINGS
    let archiveIndex = 0, tailIndex = 0, first = true
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (first) { first = false; if (start < 44) { controller.enqueue(header.slice(start, Math.min(44, end + 1))); return } }
          if (archiveIndex < archives.length) {
            const archive = archives[archiveIndex++]!, offset = Math.max(0, pcmStart - archive.start), length = Math.min(archive.length, pcmEnd - archive.start + 1) - offset
            const object = await bucket.get(archive.key, { range: { offset, length } })
            if (!object) throw new Error('录音归档缺失')
            // Each archive is bounded to a few MB, not a full meeting.
            controller.enqueue(new Uint8Array(await object.arrayBuffer())); return
          }
          if (tailIndex < tail.length) {
            const chunk = tail[tailIndex++]!
            controller.enqueue(new Uint8Array(chunk.bytes).slice(Math.max(0, pcmStart - chunk.start), Math.min(chunk.bytes.byteLength, pcmEnd - chunk.start + 1))); return
          }
          controller.close()
        } catch (error) { controller.error(error) }
      }
    })
    return new Response(stream, { status: range ? 206 : 200, headers })
  }
  async analyze(owner: string, final: boolean, provider: ProviderSettings): Promise<Response> {
    this.assertOwner(owner)
    if (this.analyzing) throw new HttpError(409, '分析正在生成，请等待完成')
    if (!provider.DEEPSEEK_API_KEY) throw new HttpError(503, '请先在个人设置中填写自己的 DeepSeek API Key')
    const meeting = this.read()!
    if (!meeting.segments.length) throw new HttpError(409, '没有待分析的确认转写')
    this.analyzing = true
    const count = meeting.segments.length, controller = new AbortController(), encoder = new TextEncoder()
    const stream = new TransformStream<Uint8Array, Uint8Array>(), writer = stream.writable.getWriter()
    const push = (event: string, value: unknown) => writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`))
    this.ctx.waitUntil((async () => {
      try {
        const result = await generateAnalysis(provider, meeting, true, text => push('delta', { text }), controller.signal)
        const current = this.read()!
        current.analyses.push({ id: crypto.randomUUID(), created: new Date().toISOString(), text: result, final: true }); current.analyzedCount = count
        this.write(current); await this.index(); await push('done', {})
      } catch (error) { await push('failure', { message: error instanceof Error ? error.message : '分析失败' }).catch(() => {}) }
      finally { this.analyzing = false; controller.abort(); await writer.close().catch(() => {}) }
    })())
    return new Response(stream.readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
  }
}
