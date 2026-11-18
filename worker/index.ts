import { z, ZodError } from 'zod'
import { HttpError, json, body, readLimited } from './lib/http'
import { openWorkspace, requireWorkspace, rateLimit } from './lib/auth'
import { MeetingRoom } from './durable-objects/meeting-room'
import { getSettings, publicSettings, settingsInput, updateSettings } from './services/settings'
import type { Meeting } from '../shared/types'

export { MeetingRoom }

const createMeetingSchema = z.object({
  title: z.string().trim().min(1).max(160),
  context: z.string().max(400).default(''),
  terms: z.string().max(4000).default(''),
  autoAnalyze: z.boolean().default(false)
})

async function handleMeetingRoute(
  parts: string[],
  method: string,
  request: Request,
  env: Env,
  userId: string
): Promise<Response> {
  if (parts.length === 1) {
    if (method === 'GET') {
      const rows = await env.DB.prepare('SELECT summary FROM meetings WHERE owner=? ORDER BY rowid DESC LIMIT 200')
        .bind(userId)
        .all<{ summary: string }>()
      return json(rows.results.map(row => JSON.parse(row.summary)))
    }
    if (method === 'POST') {
      await rateLimit(env, `create-meeting:${userId}`, 60)
      const input = createMeetingSchema.parse(await body(request))
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
      await env.DB.prepare('INSERT INTO meetings(id,owner,summary) VALUES(?,?,?)')
        .bind(
          meeting.id,
          userId,
          JSON.stringify({ ...meeting, segments: undefined, analyses: undefined, segmentCount: 0, analysisCount: 0 })
        )
        .run()
      const room = env.MEETINGS.getByName(meeting.id)
      return json(await room.initialize(userId, meeting))
    }
  }

  const id = z.uuid().parse(parts[1])
  const record = await env.DB.prepare('SELECT id FROM meetings WHERE id=? AND owner=?').bind(id, userId).first()
  if (!record) throw new HttpError(404, '会议不存在')

  const room = env.MEETINGS.getByName(id)
  if (parts.length === 2 && method === 'GET') return json(await room.detail(userId))

  if (parts[2] === 'state' && method === 'POST') {
    const { action } = z.object({ action: z.enum(['start', 'pause', 'resume', 'stop']) }).parse(await body(request))
    const provider = ['start', 'resume'].includes(action) ? await getSettings(env, userId) : undefined
    return json(await room.state(userId, action, provider))
  }
  if (parts[2] === 'mark' && method === 'POST') {
    const { segmentId } = z.object({ segmentId: z.uuid() }).parse(await body(request))
    return json(await room.mark(userId, segmentId))
  }
  if (parts[2] === 'auto-analyze' && method === 'POST') {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await body(request))
    return json(await room.autoAnalyze(userId, enabled))
  }
  if (parts[2] === 'audio') {
    if (method === 'GET') return room.audio(userId, request.headers.get('Range'))
    if (method === 'POST') {
      const sequence = z.string().regex(/^\d{1,9}$/).transform(Number).parse(request.headers.get('X-Audio-Sequence'))
      const bytes = await readLimited(request, 128000)
      return json(await room.upload(userId, sequence, bytes.buffer))
    }
  }
  if (parts[2] === 'export' && method === 'GET') {
    return json(await room.detail(userId), 200, { 'Content-Disposition': `attachment; filename="meetnote-${id}.json"` })
  }
  if (parts[2] === 'analyze' && method === 'POST') {
    await rateLimit(env, `analyze:${userId}`, 60, 60000)
    const { final } = z.object({ final: z.boolean().default(false) }).parse(await body(request))
    return room.analyze(userId, final, await getSettings(env, userId))
  }

  throw new HttpError(404, '接口不存在')
}

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const parts = url.pathname.slice(5).split('/').filter(Boolean)
  const path = parts.join('/')
  const method = request.method

  if (!['GET', 'HEAD'].includes(method) && request.headers.get('Origin') !== url.origin) {
    throw new HttpError(403, '请求来源不受信任')
  }
  if (path === 'workspace' && method === 'POST') {
    const workspace = await openWorkspace(request, env)
    return json({ ready: true }, 200, workspace.cookie ? { 'Set-Cookie': workspace.cookie } : undefined)
  }
  if (path.startsWith('auth/') || path.startsWith('setup') || path === 'users') {
    throw new HttpError(404, '无需账号，请直接打开工作台')
  }

  const user = await requireWorkspace(request, env)
  if (path === 'config' && method === 'GET') return json(publicSettings(await getSettings(env, user.id)))
  if (path === 'config' && method === 'PUT') {
    await rateLimit(env, `settings:${user.id}`, 30)
    return json(await updateSettings(env, user.id, settingsInput.parse(await body(request))))
  }
  if (path === 'config' && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM user_settings WHERE user_id=?').bind(user.id).run()
    return json(publicSettings(await getSettings(env, user.id)))
  }
  if (parts[0] === 'meetings') return handleMeetingRoute(parts, method, request, env, user.id)
  throw new HttpError(404, '接口不存在')
}

export default {
  async fetch(request, env): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    try {
      return await api(request, env)
    } catch (error) {
      if (error instanceof ZodError) return json({ statusMessage: '输入格式不正确，请检查填写内容' }, 400)
      // RPC errors preserve their message; custom properties and instanceof identity may be lost.
      const match = error instanceof Error ? /\[(\d{3})\] (.+)/.exec(error.message) : null
      const status = match ? Number(match[1]) : undefined
      if (status && status >= 400 && status < 600) return json({ statusMessage: match![2] }, status)
      console.error(
        JSON.stringify({
          event: 'api_failure',
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.name : 'UnknownError'
        })
      )
      return json({ statusMessage: '服务暂时不可用，请重试或联系管理员' }, 500)
    }
  }
} satisfies ExportedHandler<Env>
