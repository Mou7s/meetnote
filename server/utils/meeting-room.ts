import { existsSync } from 'node:fs'
import { mkdir, open, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Meeting, MeetingSummary } from '../../shared/types'
import { generateAnalysis } from '../services/analysis'
import { connectAsr, type Asr } from '../services/asr'
import { closeDb, getDb } from './db'
import { getDataDir } from './env'
import { HttpError } from './http'
import { defaultSettings, type ProviderSettings } from './settings'

interface LiveRoom {
  asr: Asr | null
  interim: { time: number; text: string } | null
  changing: boolean
  analyzing: boolean
  analysisAborted: boolean
  analysisDone: Promise<void> | null
  tail: Promise<unknown>
  inactivityTimer: ReturnType<typeof setTimeout> | null
}

const rooms = new Map<string, LiveRoom>()
const INACTIVITY_MS = 120000

function getLive(id: string): LiveRoom {
  let room = rooms.get(id)
  if (!room) {
    room = {
      asr: null,
      interim: null,
      changing: false,
      analyzing: false,
      analysisAborted: false,
      analysisDone: null,
      tail: Promise.resolve(),
      inactivityTimer: null
    }
    rooms.set(id, room)
  }
  return room
}

function pcmPath(owner: string, meetingId: string) {
  return join(getDataDir(), 'recordings', owner, `${meetingId}.pcm`)
}

function readMeeting(owner: string, id: string): Meeting {
  const row = getDb()
    .query<{ json: string }, [string, string]>('SELECT json FROM meetings WHERE id=? AND owner=?')
    .get(id, owner)
  if (!row) throw new HttpError(404, '会议不存在')
  return JSON.parse(row.json) as Meeting
}

function writeMeeting(owner: string, meeting: Meeting) {
  getDb()
    .query('UPDATE meetings SET json=? WHERE id=? AND owner=?')
    .run(JSON.stringify(meeting), meeting.id, owner)
}

function summarize(meeting: Meeting): MeetingSummary {
  const { segments, analyses, interim: _interim, ...rest } = meeting
  return { ...rest, segmentCount: segments.length, analysisCount: analyses.length }
}

function scheduleInactivity(owner: string, id: string) {
  const live = getLive(id)
  if (live.inactivityTimer) clearTimeout(live.inactivityTimer)
  live.inactivityTimer = setTimeout(() => {
    live.inactivityTimer = null
    const row = getDb()
      .query<{ json: string }, [string, string]>('SELECT json FROM meetings WHERE id=? AND owner=?')
      .get(id, owner)
    if (!row) return
    const current = JSON.parse(row.json) as Meeting
    if (current.status !== 'recording') return
    live.asr?.close()
    live.asr = null
    live.interim = null
    current.status = 'interrupted'
    current.error = '录音上传已中断。已保存部分可回放，请检查浏览器或网络。'
    writeMeeting(owner, current)
  }, INACTIVITY_MS)
  live.inactivityTimer.unref?.()
}

function clearInactivity(id: string) {
  const live = rooms.get(id)
  if (!live?.inactivityTimer) return
  clearTimeout(live.inactivityTimer)
  live.inactivityTimer = null
}

export function markInterruptedMeetingsOnStartup() {
  const db = getDb()
  const rows = db.query<{ id: string; owner: string; json: string }, []>('SELECT id, owner, json FROM meetings').all()
  for (const row of rows) {
    const meeting = JSON.parse(row.json) as Meeting
    if (meeting.status === 'recording') {
      meeting.status = 'interrupted'
      meeting.error = '实时会话已重启。已保存的录音仍可回放，转写可能不完整。'
      db.query('UPDATE meetings SET json=? WHERE id=?').run(JSON.stringify(meeting), row.id)
    }
  }
}

export function shutdownMeetingRooms() {
  for (const [id, live] of rooms) {
    clearInactivity(id)
    live.asr?.close()
    live.asr = null
    live.interim = null
  }
  rooms.clear()
  closeDb()
}

export function listMeetings(owner: string): MeetingSummary[] {
  const rows = getDb()
    .query<{ json: string }, [string]>('SELECT json FROM meetings WHERE owner=? ORDER BY rowid DESC LIMIT 200')
    .all(owner)
  return rows.map(row => summarize(JSON.parse(row.json) as Meeting))
}

export function createMeeting(
  owner: string,
  input: { title: string; context: string; terms: string; autoAnalyze: boolean }
): Meeting {
  const uniqueTerms = new Set(
    input.terms
      .split(/[\r\n,，;；]+/)
      .map(v => v.trim().toLowerCase())
      .filter(Boolean)
  )
  if (uniqueTerms.size > 50) throw new HttpError(400, '专业词最多 50 个')

  const meeting: Meeting = {
    ...input,
    id: crypto.randomUUID(),
    created: new Date().toISOString(),
    status: 'ready',
    bytes: 0,
    nextSeq: 0,
    error: '',
    analyzedCount: 0,
    segments: [],
    analyses: []
  }
  getDb().query('INSERT INTO meetings(id,owner,json) VALUES(?,?,?)').run(meeting.id, owner, JSON.stringify(meeting))
  return meeting
}

export function getMeetingDetail(owner: string, id: string): Meeting {
  const meeting = readMeeting(owner, id)
  return { ...meeting, interim: rooms.get(id)?.interim ?? null }
}

export function setAutoAnalyze(owner: string, id: string, enabled: boolean): Meeting {
  const meeting = readMeeting(owner, id)
  meeting.autoAnalyze = enabled
  writeMeeting(owner, meeting)
  return { ...meeting, interim: rooms.get(id)?.interim ?? null }
}

function recordAsrError(
  owner: string,
  id: string,
  message = '在线转写中断，录音继续保存；本场转写不完整，请检查识别配置或网络。'
) {
  const live = getLive(id)
  live.interim = null
  const meeting = readMeeting(owner, id)
  meeting.error = message
  writeMeeting(owner, meeting)
}

export async function updateMeetingState(
  owner: string,
  id: string,
  action: 'start' | 'pause' | 'resume' | 'stop',
  provider: ProviderSettings = defaultSettings()
): Promise<Meeting> {
  const meeting = readMeeting(owner, id)
  const live = getLive(id)
  if (live.changing) throw new HttpError(409, '会议状态正在更新')

  const valid =
    action === 'start'
      ? meeting.status === 'ready'
      : action === 'resume'
        ? ['paused', 'interrupted'].includes(meeting.status)
        : action === 'pause'
          ? meeting.status === 'recording'
          : ['recording', 'paused', 'interrupted'].includes(meeting.status)
  if (!valid) throw new HttpError(409, '当前会议状态不支持此操作')

  live.changing = true
  try {
    await live.tail
    if (action === 'start' || action === 'resume') {
      try {
        live.interim = null
        live.asr = await connectAsr(
          provider,
          meeting,
          (time, text, final) => {
            if (!final) {
              live.interim = { time, text }
              return
            }
            live.interim = null
            const current = readMeeting(owner, id)
            if (!current.segments.some(s => s.time === time && s.text === text)) {
              current.segments.push({ id: crypto.randomUUID(), time, text })
              writeMeeting(owner, current)
            }
          },
          () => recordAsrError(owner, id)
        )
      } catch (error) {
        recordAsrError(owner, id, error instanceof Error ? error.message : undefined)
      }
      scheduleInactivity(owner, id)
    } else {
      await live.asr?.finish()
      live.asr = null
      live.interim = null
      clearInactivity(id)
    }

    const current = readMeeting(owner, id)
    current.status = action === 'pause' ? 'paused' : action === 'stop' ? 'completed' : 'recording'
    if ((action === 'start' || action === 'resume') && !provider.ALIYUN_API_KEY) {
      current.error = '你尚未配置百炼 API Key，本场仅录音。请在个人设置中填写自己的密钥。'
    }
    writeMeeting(owner, current)
    return current
  } finally {
    live.changing = false
  }
}

export async function uploadAudioChunk(owner: string, id: string, sequence: number, raw: Uint8Array) {
  readMeeting(owner, id)
  const live = getLive(id)
  if (live.changing) throw new HttpError(409, '会议状态正在更新')

  const job = live.tail.then(async () => {
    const meeting = readMeeting(owner, id)
    if (meeting.status !== 'recording') throw new HttpError(409, '会议未处于录音状态')
    if (sequence < meeting.nextSeq) return { nextSeq: meeting.nextSeq, bytes: meeting.bytes }
    if (sequence !== meeting.nextSeq) throw new HttpError(409, '音频分块顺序不一致')
    if (!raw.byteLength || raw.byteLength > 128000 || raw.byteLength % 2) {
      throw new HttpError(400, '无效 PCM16 分块')
    }
    if (meeting.bytes + raw.byteLength > 230400000) throw new HttpError(413, '单场录音最多两小时')

    const file = pcmPath(owner, id)
    await mkdir(dirname(file), { recursive: true })
    const fh = await open(file, existsSync(file) && meeting.bytes > 0 ? 'r+' : 'w+')
    try {
      await fh.write(raw, 0, raw.byteLength, meeting.bytes)
    } finally {
      await fh.close()
    }

    meeting.bytes += raw.byteLength
    meeting.nextSeq++
    writeMeeting(owner, meeting)
    scheduleInactivity(owner, id)

    if (live.asr) {
      const copy = new Uint8Array(raw).buffer
      void live.asr.push(copy)
    }
    return { nextSeq: meeting.nextSeq, bytes: meeting.bytes }
  })

  live.tail = job.catch(() => {})
  return job
}

export function streamMeetingAudio(owner: string, id: string, range: string | null): Response {
  const meeting = readMeeting(owner, id)
  const size = meeting.bytes
  if (!size) throw new HttpError(404, '尚无已保存录音')

  const file = pcmPath(owner, id)
  if (!existsSync(file)) throw new HttpError(404, '录音文件缺失')

  const total = size + 44
  const header = new Uint8Array(44)
  const data = new DataView(header.buffer)
  const encoder = new TextEncoder()
  header.set(encoder.encode('RIFF'))
  data.setUint32(4, size + 36, true)
  header.set(encoder.encode('WAVEfmt '), 8)
  data.setUint32(16, 16, true)
  data.setUint16(20, 1, true)
  data.setUint16(22, 1, true)
  data.setUint32(24, 16000, true)
  data.setUint32(28, 32000, true)
  data.setUint16(32, 2, true)
  data.setUint16(34, 16, true)
  header.set(encoder.encode('data'), 36)
  data.setUint32(40, size, true)

  let start = 0
  let end = total - 1
  const headers: Record<string, string> = {
    'Content-Type': 'audio/wav',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range)
    if (!match) throw new HttpError(416, '无效音频范围')
    start = Number(match[1])
    end = match[2] ? Math.min(Number(match[2]), end) : end
    if (start > end || start >= total) throw new HttpError(416, '音频范围超出文件')
    headers['Content-Range'] = `bytes ${start}-${end}/${total}`
  }
  headers['Content-Length'] = String(end - start + 1)

  const pcmStart = Math.max(0, start - 44)
  const pcmEnd = end - 44
  let cursor = pcmStart
  let sentHeader = false
  let handle: FileHandle | null = null

  const closeHandle = async () => {
    if (!handle) return
    const target = handle
    handle = null
    await target.close().catch(() => {})
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!sentHeader) {
          sentHeader = true
          if (start < 44) {
            controller.enqueue(header.slice(start, Math.min(44, end + 1)))
            return
          }
        }
        if (cursor > pcmEnd) {
          await closeHandle()
          controller.close()
          return
        }
        if (!handle) handle = await open(file, 'r')
        const toRead = Math.min(65536, pcmEnd - cursor + 1)
        const buf = new Uint8Array(toRead)
        const { bytesRead } = await handle.read(buf, 0, toRead, cursor)
        if (!bytesRead) {
          await closeHandle()
          controller.close()
          return
        }
        cursor += bytesRead
        controller.enqueue(bytesRead === toRead ? buf : buf.slice(0, bytesRead))
      } catch (error) {
        await closeHandle()
        controller.error(error)
      }
    },
    async cancel() {
      await closeHandle()
    }
  })

  return new Response(stream, { status: range ? 206 : 200, headers })
}

export async function streamMeetingAnalysis(
  owner: string,
  id: string,
  final: boolean,
  provider: ProviderSettings
): Promise<Response> {
  let meeting = readMeeting(owner, id)
  const live = getLive(id)
  if (live.analyzing && live.analysisAborted && live.analysisDone) {
    await live.analysisDone.catch(() => {})
    meeting = readMeeting(owner, id)
  }
  if (live.analyzing) throw new HttpError(409, '分析正在生成，请等待完成')
  if (!provider.DEEPSEEK_API_KEY) {
    throw new HttpError(503, '请先在个人设置中填写自己的 DeepSeek API Key')
  }
  if (!meeting.segments.length) throw new HttpError(409, '没有待分析的确认转写')
  if (!final && meeting.analyses.length > 0 && meeting.segments.length <= meeting.analyzedCount) {
    throw new HttpError(409, '当前没有新增确认转写')
  }

  live.analyzing = true
  live.analysisAborted = false
  const count = meeting.segments.length
  const controller = new AbortController()
  const encoder = new TextEncoder()
  let streamClosed = false

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      const writeText = (chunk: string) => {
        if (streamClosed || controller.signal.aborted) return
        try {
          streamController.enqueue(encoder.encode(chunk))
        } catch {
          streamClosed = true
        }
      }
      const push = async (event: string, value: unknown) => {
        writeText(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
      }

      // Keep Bun's idleTimeout from closing quiet SSE connections before the first LLM token arrives.
      const keepalive = setInterval(() => {
        writeText(': keepalive\n\n')
      }, 5000)

      live.analysisDone = (async () => {
        try {
          const result = await generateAnalysis(
            provider,
            meeting,
            final,
            text => push('delta', { text }),
            controller.signal
          )
          if (controller.signal.aborted) return
          const current = readMeeting(owner, id)
          current.analyses.push({
            id: crypto.randomUUID(),
            created: new Date().toISOString(),
            text: result,
            final,
            coveredCount: count
          })
          current.analyzedCount = count
          writeMeeting(owner, current)
          await push('done', {})
        } catch (error) {
          if (!controller.signal.aborted) {
            await push('failure', { message: error instanceof Error ? error.message : '分析失败' }).catch(() => {})
          }
        } finally {
          clearInterval(keepalive)
          live.analyzing = false
          live.analysisAborted = false
          live.analysisDone = null
          controller.abort()
          if (!streamClosed) {
            streamClosed = true
            try {
              streamController.close()
            } catch {
              /* Already closed. */
            }
          }
        }
      })()
    },
    cancel() {
      streamClosed = true
      live.analysisAborted = true
      controller.abort()
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}
