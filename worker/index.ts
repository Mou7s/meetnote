import { z, ZodError } from 'zod'
import { HttpError, json, body, readLimited } from './http'
import { openWorkspace, requireWorkspace, rateLimit } from './auth'
import { MeetingRoom } from './meeting'
import type { Meeting } from '../shared/types'
import { getSettings, publicSettings, settingsInput, updateSettings } from './settings'
export { MeetingRoom }

const settings = z.object({ title: z.string().trim().min(1).max(160), context: z.string().max(400).default(''), terms: z.string().max(4000).default(''), autoAnalyze: z.boolean().default(false) })

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), parts = url.pathname.slice(5).split('/').filter(Boolean), path = parts.join('/'), method = request.method
  if (!['GET', 'HEAD'].includes(method) && request.headers.get('Origin') !== url.origin) throw new HttpError(403, '请求来源不受信任')
  if (path === 'workspace' && method === 'POST') {
    const workspace = await openWorkspace(request, env)
    return json({ ready: true }, 200, workspace.cookie ? { 'Set-Cookie': workspace.cookie } : undefined)
  }
  if (path.startsWith('auth/') || path.startsWith('setup') || path === 'users') throw new HttpError(404, '无需账号，请直接打开工作台')
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
  if (parts[0] !== 'meetings') throw new HttpError(404, '接口不存在')
  if (parts.length === 1) {
    if (method === 'GET') {
      const rows = await env.DB.prepare('SELECT summary FROM meetings WHERE owner=? ORDER BY rowid DESC LIMIT 200').bind(user.id).all<{ summary: string }>()
      return json(rows.results.map(row => JSON.parse(row.summary)))
    }
    if (method === 'POST') {
      await rateLimit(env, `create-meeting:${user.id}`, 60)
      const input = settings.parse(await body(request))
      if (new Set(input.terms.split(/[\r\n,，;；]+/).map(v => v.trim().toLowerCase()).filter(Boolean)).size > 50) throw new HttpError(400, '专业词最多 50 个')
      const meeting: Meeting = { ...input, id: crypto.randomUUID(), created: new Date().toISOString(), status: 'ready', bytes: 0, nextSeq: 0, error: '', analyzedCount: 0, segments: [], analyses: [] }
      await env.DB.prepare('INSERT INTO meetings(id,owner,summary) VALUES(?,?,?)').bind(meeting.id, user.id, JSON.stringify({ ...meeting, segments: undefined, analyses: undefined, segmentCount: 0, analysisCount: 0 })).run()
      const room = env.MEETINGS.getByName(meeting.id)
      return json(await room.initialize(user.id, meeting))
    }
  }
  const id = z.uuid().parse(parts[1])
  const record = await env.DB.prepare('SELECT id FROM meetings WHERE id=? AND owner=?').bind(id, user.id).first()
  if (!record) throw new HttpError(404, '会议不存在')
  const room = env.MEETINGS.getByName(id)
  if (parts.length === 2 && method === 'GET') return json(await room.detail(user.id))
  if (parts[2] === 'state' && method === 'POST') {
    const { action } = z.object({ action: z.enum(['start', 'pause', 'resume', 'stop']) }).parse(await body(request))
    return json(await room.state(user.id, action, ['start', 'resume'].includes(action) ? await getSettings(env, user.id) : undefined))
  }
  if (parts[2] === 'mark' && method === 'POST') return json(await room.mark(user.id, z.object({ segmentId: z.uuid() }).parse(await body(request)).segmentId))
  if (parts[2] === 'auto-analyze' && method === 'POST') return json(await room.autoAnalyze(user.id, z.object({ enabled: z.boolean() }).parse(await body(request)).enabled))
  if (parts[2] === 'audio') {
    if (method === 'GET') return room.audio(user.id, request.headers.get('Range'))
    if (method === 'POST') {
      const sequence = z.string().regex(/^\d{1,9}$/).transform(Number).parse(request.headers.get('X-Audio-Sequence'))
      const bytes = await readLimited(request, 128000)
      return json(await room.upload(user.id, sequence, bytes.buffer))
    }
  }
  if (parts[2] === 'export' && method === 'GET') return json(await room.detail(user.id), 200, { 'Content-Disposition': `attachment; filename="meetnote-${id}.json"` })
  if (parts[2] === 'analyze' && method === 'POST') {
    await rateLimit(env, `analyze:${user.id}`, 60, 60000)
    return room.analyze(user.id, z.object({ final: z.boolean().default(false) }).parse(await body(request)).final, await getSettings(env, user.id))
  }
  throw new HttpError(404, '接口不存在')
}

export default {
  async fetch(request, env): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    try { return await api(request, env) }
    catch (error) {
      if (error instanceof ZodError) return json({ statusMessage: '输入格式不正确，请检查填写内容' }, 400)
      // RPC errors preserve their message; custom properties and instanceof identity may be lost.
      const match = error instanceof Error ? /\[(\d{3})\] (.+)/.exec(error.message) : null
      const status = match ? Number(match[1]) : undefined
      if (status && status >= 400 && status < 600) return json({ statusMessage: match![2] }, status)
      console.error(JSON.stringify({ event: 'api_failure', path: new URL(request.url).pathname, error: error instanceof Error ? error.name : 'UnknownError' }))
      return json({ statusMessage: '服务暂时不可用，请重试或联系管理员' }, 500)
    }
  }
} satisfies ExportedHandler<Env>
