import { createHash, randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import { getCookie, getHeader, getRequestIP, getRequestURL } from 'h3'
import type { User } from '../../shared/types'
import { getDb } from './db'
import { HttpError } from './http'

export const digest = (value: string) => createHash('sha256').update(value).digest('hex')

const legacyCookieName = 'meetnote_session'
const workspaceCookieName = 'meetnote_workspace'

export function requireWorkspace(event: H3Event): User {
  const token = getCookie(event, workspaceCookieName) || ''
  if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) {
    throw new HttpError(401, '请刷新页面以初始化当前浏览器的工作空间')
  }
  const user = getDb()
    .query<User, [string, number]>(
      'SELECT u.id,u.username,u.name,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>?'
    )
    .get(digest(token), Date.now())
  if (!user) {
    throw new HttpError(401, '当前浏览器的工作空间已失效，请刷新页面')
  }
  return user
}

function legacyUser(event: H3Event): User | null {
  const token = getCookie(event, legacyCookieName) || ''
  if (!token || token.length > 128) return null
  return (
    getDb()
      .query<User, [string, number]>(
        'SELECT u.id,u.username,u.name,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>?'
      )
      .get(digest(token), Date.now()) || null
  )
}

export function openWorkspace(event: H3Event) {
  try {
    return { user: requireWorkspace(event), cookie: undefined }
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 401) throw error
  }
  const ip =
    getHeader(event, 'cf-connecting-ip') ||
    getHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim() ||
    getRequestIP(event) ||
    'local'
  rateLimit(`workspace:${ip}`, 50, 86400000)

  const previous = legacyUser(event)
  const user: User = previous
    ? { ...previous, name: '当前浏览器', role: 'member' }
    : {
        id: crypto.randomUUID(),
        username: `browser_${randomBytes(12).toString('hex')}`,
        name: '当前浏览器',
        role: 'member'
      }
  const token = randomBytes(32).toString('base64url')
  const maxAge = 365 * 86400
  const db = getDb()
  const writeSession = db.transaction(() => {
    db.query('INSERT OR IGNORE INTO users VALUES(?,?,?,?,?)').run(
      user.id,
      user.username,
      user.name,
      user.role,
      '!anonymous-workspace-no-password'
    )
    db.query('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), user.id, Date.now() + maxAge * 1000)
  })
  writeSession()

  const url = getRequestURL(event)
  const isHttps = url.protocol === 'https:'
  return {
    user,
    cookie: `${workspaceCookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isHttps ? '; Secure' : ''}`
  }
}

export function rateLimit(key: string, limit: number, window = 900000) {
  const hash = digest(key)
  const now = Date.now()
  const row = getDb()
    .query<{ count: number }, [string, number, number, number]>(
      'INSERT INTO attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<? THEN 1 ELSE count+1 END, expires=CASE WHEN expires<? THEN excluded.expires ELSE expires END RETURNING count'
    )
    .get(hash, now + window, now, now)
  if (!row || row.count > limit) {
    throw new HttpError(429, '操作过于频繁，请稍后再试')
  }
}
