import { test, expect, beforeAll, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const root = join(import.meta.dir, '..')
const data = mkdtempSync(join(tmpdir(), 'meetnote-nuxt-test-'))
const origin = 'http://127.0.0.1:3467'
const entry = join(root, '.output/server/index.mjs')

let server: ReturnType<typeof Bun.spawn> | undefined
let firstCookie = ''
let otherCookie = ''
let meetingId = ''

async function call(
  path: string,
  options: { method?: string; cookie?: string; json?: unknown; body?: Uint8Array; headers?: Record<string, string> } = {}
) {
  return fetch(`${origin}/api/${path}`, {
    method: options.method || 'GET',
    headers: {
      Origin: origin,
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.json ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    },
    body: options.json ? JSON.stringify(options.json) : options.body
  })
}

async function boot() {
  server = Bun.spawn(['bun', 'run', entry], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '3467',
      USER_KEYS_ENCRYPTION_KEY: 'ab'.repeat(32),
      MEETNOTE_DATA_DIR: data,
      NITRO_BUN_IDLE_TIMEOUT: '120'
    },
    stdout: 'ignore',
    stderr: 'pipe'
  })
  for (let i = 0; i < 200; i++) {
    if (server.exitCode !== null) throw new Error(await new Response(server.stderr).text())
    try {
      await fetch(origin)
      return
    } catch {
      await Bun.sleep(50)
    }
  }
  throw new Error('Server startup timed out')
}

async function stopServer() {
  if (!server || server.exitCode !== null) return
  server.kill()
  await server.exited
}

beforeAll(async () => {
  const build = Bun.spawn(['bun', '--bun', 'node_modules/nuxt/bin/nuxt.mjs', 'build'], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'pipe'
  })
  if ((await build.exited) !== 0) {
    throw new Error(await new Response(build.stderr).text())
  }
  await boot()
}, 90000)

afterAll(async () => {
  await stopServer()
  if (!resolve(data).startsWith(resolve(tmpdir()) + sep) || !data.includes('meetnote-nuxt-test-')) {
    throw new Error('Unsafe cleanup path')
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(data, { recursive: true, force: true })
      break
    } catch (error) {
      if (attempt === 19) throw error
      await Bun.sleep(100)
    }
  }
})

test('workspace opens without registration and rejects cross-origin initialization', async () => {
  expect((await call('meetings')).status).toBe(401)
  expect((await call('workspace', { method: 'POST', headers: { Origin: 'https://attacker.example' }, json: {} })).status).toBe(403)
  const response = await call('workspace', { method: 'POST', json: {} })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ready: true })
  expect(response.headers.get('set-cookie')).toContain('HttpOnly')
  expect(response.headers.get('set-cookie')).toContain('SameSite=Strict')
  firstCookie = response.headers.get('set-cookie')!.split(';')[0]!
  const same = await call('workspace', { method: 'POST', cookie: firstCookie, json: {} })
  expect(same.status).toBe(200)
  expect(same.headers.get('set-cookie')).toBeNull()
  const other = await call('workspace', { method: 'POST', json: {} })
  otherCookie = other.headers.get('set-cookie')!.split(';')[0]!
  expect(otherCookie).not.toBe(firstCookie)
})

test('meeting ownership protects detail, audio, export, auto-analyze and analysis', async () => {
  const result = await call('meetings', { method: 'POST', cookie: firstCookie, json: { title: '隔离验证会议' } })
  expect(result.status).toBe(200)
  meetingId = (await result.json()).id
  expect(await (await call('meetings', { cookie: otherCookie })).json()).toEqual([])
  for (const suffix of ['', '/audio', '/export']) {
    expect((await call(`meetings/${meetingId}${suffix}`, { cookie: otherCookie })).status).toBe(404)
  }
  for (const suffix of ['state', 'auto-analyze', 'analyze']) {
    expect(
      (
        await call(`meetings/${meetingId}/${suffix}`, {
          method: 'POST',
          cookie: otherCookie,
          json: { action: 'start', final: true, enabled: true }
        })
      ).status
    ).toBe(404)
  }
  expect(
    (
      await call(`meetings/${meetingId}/mark`, {
        method: 'POST',
        cookie: firstCookie,
        json: { segmentId: crypto.randomUUID() }
      })
    ).status
  ).toBe(404)
  const toggled = await call(`meetings/${meetingId}/auto-analyze`, {
    method: 'POST',
    cookie: firstCookie,
    json: { enabled: true }
  })
  expect(toggled.status).toBe(200)
  expect((await toggled.json()).autoAnalyze).toBe(true)
})

test('personal keys are encrypted at rest, never echoed, isolated and removable', async () => {
  const input = {
    aliyunKey: 'synthetic-aliyun-secret',
    deepseekKey: 'synthetic-deepseek-secret',
    aliyunHost: 'ws-example.cn-beijing.maas.aliyuncs.com',
    aliyunModel: 'qwen-audio-3.1-asr-flash-streaming',
    deepseekModel: 'deepseek-flash'
  }
  expect((await call('config', { method: 'PUT', json: input })).status).toBe(401)
  const saved = await call('config', { method: 'PUT', cookie: firstCookie, json: input })
  expect(saved.status).toBe(200)
  const savedText = await saved.text()
  expect(savedText).not.toContain('synthetic-')
  expect(JSON.parse(savedText)).toMatchObject({
    asr: true,
    ai: true,
    aliyunHost: input.aliyunHost,
    encryptionReady: true
  })

  const normalized = await call('config', {
    method: 'PUT',
    cookie: firstCookie,
    json: { ...input, aliyunKey: '', deepseekKey: '', aliyunHost: `https://${input.aliyunHost}/api-ws/v1/inference` }
  })
  expect(normalized.status).toBe(200)
  expect(await normalized.json()).toMatchObject({ asr: true, ai: true, aliyunHost: input.aliyunHost })

  expect(
    (
      await call('config/test', {
        method: 'POST',
        json: { service: 'ai', deepseekKey: 'test', deepseekModel: 'deepseek-flash' }
      })
    ).status
  ).toBe(401)
  expect(
    (
      await call('config/test', {
        method: 'POST',
        cookie: firstCookie,
        json: {
          service: 'asr',
          aliyunHost: 'attacker.example',
          aliyunModel: 'qwen-audio-3.1-asr-flash-streaming'
        }
      })
    ).status
  ).toBe(400)
  const missingKeyTest = await call('config/test', {
    method: 'POST',
    cookie: otherCookie,
    json: { service: 'ai', useSaved: true, deepseekModel: 'deepseek-flash' }
  })
  expect(missingKeyTest.status).toBe(200)
  expect(await missingKeyTest.json()).toMatchObject({ ok: false })

  const other = await call('config', { cookie: otherCookie })
  expect(await other.json()).toMatchObject({ asr: false, ai: false, aliyunHost: 'dashscope.aliyuncs.com' })

  const read = await call('config', { cookie: firstCookie })
  expect(await read.text()).not.toContain('synthetic-')

  const db = new Database(join(data, 'meetnote.sqlite'), { readonly: true })
  const rows = db.query<{ ciphertext: string }, []>('SELECT ciphertext FROM user_settings').all()
  db.close()
  expect(rows.length).toBe(1)
  expect(rows[0]!.ciphertext).toContain('v1:')
  expect(rows[0]!.ciphertext).not.toContain('synthetic-')
  expect(rows[0]!.ciphertext).not.toContain('ws-example')

  const preserved = await call('config', {
    method: 'PUT',
    cookie: firstCookie,
    json: { ...input, aliyunKey: '', deepseekKey: '' }
  })
  expect(await preserved.json()).toMatchObject({ asr: true, ai: true })
  expect(
    (await call('config', { method: 'PUT', cookie: firstCookie, json: { ...input, aliyunHost: 'attacker.example' } }))
      .status
  ).toBe(400)

  const removed = await call('config', {
    method: 'PUT',
    cookie: firstCookie,
    json: { ...input, aliyunKey: '', deepseekKey: '', clearAliyun: true, clearDeepseek: true }
  })
  expect(await removed.json()).toMatchObject({ asr: false, ai: false })
  expect((await call('config', { method: 'DELETE', cookie: firstCookie })).status).toBe(200)
  expect(await (await call('config', { cookie: firstCookie })).json()).toMatchObject({
    asr: false,
    ai: false,
    aliyunHost: 'dashscope.aliyuncs.com'
  })
})

test('account and login routes are no longer exposed', async () => {
  for (const path of ['auth/register', 'auth/login', 'setup', 'users']) {
    expect((await call(path, { method: 'POST', cookie: firstCookie, json: {} })).status).toBe(404)
  }
  expect((await call('setup/status')).status).toBe(404)
  expect((await call('nonexistent', { cookie: firstCookie })).status).toBe(404)
})

test('PCM upload is ordered, retry-safe and preserves WAV headers and ranges', async () => {
  expect(
    (
      await call(`meetings/${meetingId}/audio`, {
        method: 'POST',
        cookie: firstCookie,
        body: new Uint8Array(8000),
        headers: { 'X-Audio-Sequence': '0' }
      })
    ).status
  ).toBe(409)
  expect(
    (await call(`meetings/${meetingId}/state`, { method: 'POST', cookie: firstCookie, json: { action: 'start' } })).status
  ).toBe(200)

  const bytes = new Uint8Array(8000).fill(42)
  const upload = (seq: string, chunk = bytes) =>
    call(`meetings/${meetingId}/audio`, {
      method: 'POST',
      cookie: firstCookie,
      body: chunk,
      headers: { 'X-Audio-Sequence': seq, 'Content-Type': 'application/octet-stream' }
    })

  expect((await upload('2')).status).toBe(409)
  const results = await Promise.all([upload('0'), upload('0')])
  expect(results.every(r => r.status === 200)).toBe(true)
  expect((await upload('1', new Uint8Array(3))).status).toBe(400)

  const pause = await call(`meetings/${meetingId}/state`, {
    method: 'POST',
    cookie: firstCookie,
    json: { action: 'pause' }
  })
  expect((await pause.json()).bytes).toBe(8000)
  expect((await upload('1')).status).toBe(409)

  const full = await call(`meetings/${meetingId}/audio`, { cookie: firstCookie })
  const wav = Buffer.from(await full.arrayBuffer())
  expect(wav.length).toBe(8044)
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
  expect(wav.readUInt32LE(24)).toBe(16000)
  expect(wav.readUInt32LE(40)).toBe(8000)
  expect(wav.subarray(44)).toEqual(Buffer.from(bytes))

  const range = await call(`meetings/${meetingId}/audio`, {
    cookie: firstCookie,
    headers: { Range: 'bytes=40-49' }
  })
  expect(range.status).toBe(206)
  expect(Buffer.from(await range.arrayBuffer())).toEqual(wav.subarray(40, 50))
  expect((await call(`meetings/${meetingId}/audio`, { cookie: firstCookie, headers: { Range: 'bytes=9000-' } })).status).toBe(
    416
  )
})

test('restart preserves accounts, session and audio and marks unfinished meetings interrupted', async () => {
  expect(
    (await call(`meetings/${meetingId}/state`, { method: 'POST', cookie: firstCookie, json: { action: 'resume' } })).status
  ).toBe(200)
  await stopServer()
  await boot()
  const response = await call(`meetings/${meetingId}`, { cookie: firstCookie })
  const meeting = await response.json()
  expect(meeting.status).toBe('interrupted')
  expect(meeting.bytes).toBe(8000)
  expect(meeting.error).toContain('重启')
  expect(
    (await call(`meetings/${meetingId}/state`, { method: 'POST', cookie: firstCookie, json: { action: 'stop' } })).status
  ).toBe(200)
  expect(
    (await call(`meetings/${meetingId}/state`, { method: 'POST', cookie: firstCookie, json: { action: 'resume' } })).status
  ).toBe(409)
}, 30000)

test('multi-chunk recordings remain byte-exact and seekable', async () => {
  const create = await call('meetings', { method: 'POST', cookie: firstCookie, json: { title: '多块录音边界验证' } })
  const id = (await create.json()).id
  expect((await call(`meetings/${id}/state`, { method: 'POST', cookie: firstCookie, json: { action: 'start' } })).status).toBe(
    200
  )
  const blocks = Array.from({ length: 10 }, (_, index) => new Uint8Array(128000).fill(index))
  for (let index = 0; index < blocks.length; index++) {
    expect(
      (
        await call(`meetings/${id}/audio`, {
          method: 'POST',
          cookie: firstCookie,
          body: blocks[index],
          headers: { 'X-Audio-Sequence': String(index) }
        })
      ).status
    ).toBe(200)
  }
  const stopped = await call(`meetings/${id}/state`, { method: 'POST', cookie: firstCookie, json: { action: 'stop' } })
  expect(stopped.status).toBe(200)

  const audio = await call(`meetings/${id}/audio`, { cookie: firstCookie })
  const wav = Buffer.from(await audio.arrayBuffer())
  expect(wav.length).toBe(1280044)
  expect(wav.subarray(44)).toEqual(Buffer.concat(blocks.map(b => Buffer.from(b))))

  const start = 1024038
  const end = 1024058
  const range = await call(`meetings/${id}/audio`, { cookie: firstCookie, headers: { Range: `bytes=${start}-${end}` } })
  expect(range.status).toBe(206)
  expect(Buffer.from(await range.arrayBuffer())).toEqual(wav.subarray(start, end + 1))
})

test('missing or forged browser identifiers cannot access another workspace', async () => {
  expect((await call('meetings', { cookie: 'meetnote_workspace=forged' })).status).toBe(401)
  const fresh = await call('workspace', { method: 'POST', json: {} })
  const cookie = fresh.headers.get('set-cookie')!.split(';')[0]!
  expect(await (await call('meetings', { cookie })).json()).toEqual([])
  expect(await (await call('config', { cookie })).json()).toMatchObject({ asr: false, ai: false })
  expect((await call('meetings', { cookie: firstCookie })).status).toBe(200)
})
