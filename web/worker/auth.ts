import { randomBytes, createHash } from 'node:crypto'
import { HttpError } from './http'
import type { User } from '../shared/types'
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const cookieName = 'meetnote_session'
const workspaceCookieName = 'meetnote_workspace'
export function workspaceToken(request: Request) {
  return request.headers.get('Cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(workspaceCookieName + '='))?.slice(workspaceCookieName.length + 1) || ''
}
export async function requireWorkspace(request: Request, env: Env): Promise<User> {
  const token = workspaceToken(request)
  if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) throw new HttpError(401, '请刷新页面以初始化当前浏览器的工作空间')
  const user = await env.DB.prepare('SELECT u.id,u.username,u.name,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>?').bind(digest(token), Date.now()).first<User>()
  if (!user) throw new HttpError(401, '当前浏览器的工作空间已失效，请刷新页面')
  return user
}
export async function openWorkspace(request: Request, env: Env) {
  try { return { user: await requireWorkspace(request, env), cookie: undefined } } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 401) throw error
  }
  await rateLimit(env, `workspace:${request.headers.get('CF-Connecting-IP') || 'local'}`, 50, 86400000)
  // Preserve this browser's existing data when moving away from the previous login flow.
  let previous: User | null = null
  if (sessionToken(request)) { try { previous = await legacyUser(request, env) } catch { /* Expired legacy cookie. */ } }
  const user: User = previous ? { ...previous, name: '当前浏览器', role: 'member' } : { id: crypto.randomUUID(), username: `browser_${randomBytes(12).toString('hex')}`, name: '当前浏览器', role: 'member' }
  const token = randomBytes(32).toString('base64url'), maxAge = 365 * 86400
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO users VALUES(?,?,?,?,?)').bind(user.id, user.username, user.name, user.role, '!anonymous-workspace-no-password'),
    env.DB.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(digest(token), user.id, Date.now() + maxAge * 1000)
  ])
  const local = ['localhost', '127.0.0.1'].includes(new URL(request.url).hostname)
  return { user, cookie: `${workspaceCookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${local ? '' : '; Secure'}` }
}
export function sessionToken(request: Request) {
  return request.headers.get('Cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || ''
}
async function legacyUser(request: Request, env: Env): Promise<User> {
  const token = sessionToken(request)
  if (!token || token.length > 128) throw new HttpError(401, '请先登录')
  const user = await env.DB.prepare('SELECT u.id,u.username,u.name,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>?').bind(digest(token), Date.now()).first<User>()
  if (!user) throw new HttpError(401, '登录已过期')
  return user
}
export async function rateLimit(env: Env, key: string, limit: number, window = 900000) {
  const hash = digest(key), now = Date.now()
  const row = await env.DB.prepare('INSERT INTO attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<? THEN 1 ELSE count+1 END, expires=CASE WHEN expires<? THEN excluded.expires ELSE expires END RETURNING count').bind(hash, now + window, now, now).first<{ count: number }>()
  if (!row || row.count > limit) throw new HttpError(429, '操作过于频繁，请稍后再试')
}
