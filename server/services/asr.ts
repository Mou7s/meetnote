import type { ConfigTestResult, Meeting } from '../../shared/types'
import { ALIYUN_MODELS, isSupportedAliyunHost, type ProviderSettings } from '../utils/settings'

export interface Asr {
  push: (bytes: ArrayBuffer) => Promise<void>
  finish: () => Promise<void>
  close: () => void
}

type BunWsConstructor = new (url: string | URL, options?: Bun.WebSocketOptions) => WebSocket
const BunWebSocket = WebSocket as unknown as BunWsConstructor

function buildRunTaskPayload(model: string, meeting?: Pick<Meeting, 'terms' | 'context'>) {
  const parameters: Record<string, unknown> = { format: 'pcm', sample_rate: 16000, language_hints: ['zh'] }
  let input = {}
  if (model === 'qwen-audio-3.1-asr-flash-streaming') {
    parameters.vad_model = 'far_field_meeting_16k'
    parameters.heartbeat = true
    if (meeting?.terms) {
      parameters.vocabulary = Object.fromEntries(
        meeting.terms
          .split(/[\r\n,，;；]+/)
          .map(s => s.trim())
          .filter(Boolean)
          .map(s => [s, 3])
      )
    }
    if (meeting?.context) {
      input = { context: [{ role: 'user', content: [{ type: 'input_text', text: meeting.context }] }] }
    }
  }
  if (model === 'paraformer-realtime-v2') {
    parameters.semantic_punctuation_enabled = true
    parameters.heartbeat = true
  }
  return { parameters, input }
}

export async function testAsrConnection(env: ProviderSettings): Promise<ConfigTestResult> {
  if (!env.ALIYUN_API_KEY) return { ok: false, message: '请先填写百炼 API Key' }
  const host = env.ALIYUN_HOST
  if (!isSupportedAliyunHost(host)) return { ok: false, message: '百炼 API Host 无效' }
  const model = env.ALIYUN_MODEL
  if (!(ALIYUN_MODELS as readonly string[]).includes(model)) {
    return { ok: false, message: '百炼模型配置无效' }
  }

  const startedAt = Date.now()
  const task = crypto.randomUUID().replaceAll('-', '')
  const socket = new BunWebSocket(`wss://${host}/api-ws/v1/inference`, {
    headers: { Authorization: `Bearer ${env.ALIYUN_API_KEY}` }
  })

  return new Promise<ConfigTestResult>(resolve => {
    let opened = false
    let settled = false
    const finish = (ok: boolean, message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close(1000)
      } catch {
        /* Already closed. */
      }
      resolve({ ok, message, latencyMs: Date.now() - startedAt })
    }

    const timer = setTimeout(() => {
      finish(false, opened ? '百炼任务启动超时，请检查模型权限或地域 Host' : '连接百炼 WebSocket 超时，请检查 API Host 与网络')
    }, 15000)

    socket.addEventListener('open', () => {
      opened = true
      const { parameters, input } = buildRunTaskPayload(model)
      socket.send(
        JSON.stringify({
          header: { action: 'run-task', task_id: task, streaming: 'duplex' },
          payload: { task_group: 'audio', task: 'asr', function: 'recognition', model, parameters, input }
        })
      )
    })

    socket.addEventListener('message', event => {
      try {
        const packet = JSON.parse(String(event.data))
        if (packet.header?.event === 'task-started') {
          try {
            socket.send(
              JSON.stringify({
                header: { action: 'finish-task', task_id: task, streaming: 'duplex' },
                payload: { input: {} }
              })
            )
          } catch {
            /* Ignore send errors during teardown. */
          }
          finish(true, `百炼连接正常（${model}）`)
        } else if (packet.header?.event === 'task-failed') {
          const detail = packet.header?.error_message || packet.payload?.message
          finish(
            false,
            typeof detail === 'string' && detail.trim()
              ? `百炼校验失败：${detail.slice(0, 120)}`
              : '百炼拒绝任务，请确认密钥有效、已开通该模型权限且 API Host 与业务空间地域一致'
          )
        }
      } catch {
        finish(false, '百炼返回了无法解析的响应')
      }
    })

    socket.addEventListener('error', () => {
      finish(false, '无法连接百炼 WebSocket，请检查 API Key、API Host 与网络')
    })

    socket.addEventListener('close', event => {
      if (!settled) {
        finish(
          false,
          opened
            ? `百炼连接异常关闭（code ${event.code}），请确认模型权限与密钥地域一致`
            : '百炼握手失败，请确认 API Key 有效且 API Host 与密钥所属地域一致'
        )
      }
    })
  })
}

export async function connectAsr(
  env: ProviderSettings,
  meeting: Meeting,
  onSentence: (time: number, text: string, final: boolean) => void,
  onFailure: () => void
): Promise<Asr | null> {
  if (!env.ALIYUN_API_KEY) return null
  const host = env.ALIYUN_HOST
  if (!isSupportedAliyunHost(host)) throw new Error('百炼 API Host 无效')
  const model: string = env.ALIYUN_MODEL
  if (!(ALIYUN_MODELS as readonly string[]).includes(model)) {
    throw new Error('百炼模型配置无效')
  }

  const socket = new BunWebSocket(`wss://${host}/api-ws/v1/inference`, {
    headers: { Authorization: `Bearer ${env.ALIYUN_API_KEY}` }
  })
  socket.binaryType = 'arraybuffer'

  const task = crypto.randomUUID().replaceAll('-', '')
  const offset = meeting.bytes / 32000
  let opened = false
  let ready = false
  let done = false
  let failed = false
  let finishResolve: () => void = () => {}
  let startResolve: () => void = () => {}
  let startReject: (error: Error) => void = () => {}

  const started = new Promise<void>((resolve, reject) => {
    startResolve = resolve
    startReject = reject
  })
  const finished = new Promise<void>(resolve => {
    finishResolve = resolve
  })

  const fail = (message?: string) => {
    if (failed || done) return
    failed = true
    ready = false
    if (opened) onFailure()
    startReject(
      new Error(message || (opened ? '百炼任务失败' : '无法连接百炼 WebSocket，请检查 API Key、API Host 与网络。'))
    )
    finishResolve()
    try {
      socket.close(1011, 'ASR failed')
    } catch {
      /* Already closed. */
    }
  }

  const handshakeTimer = setTimeout(() => {
    if (!opened) fail('连接百炼 WebSocket 超时，请检查 API Host 与网络。')
  }, 20000)

  socket.addEventListener('error', () => fail())
  socket.addEventListener('close', () => {
    if (!done) fail()
  })
  socket.addEventListener('message', event => {
    try {
      const packet = JSON.parse(String(event.data))
      switch (packet.header?.event) {
        case 'task-started':
          ready = true
          startResolve()
          break
        case 'task-finished':
          done = true
          ready = false
          finishResolve()
          socket.close(1000)
          break
        case 'task-failed':
          fail('百炼转写任务失败，请检查模型权限、API Host 或密钥。')
          break
        case 'result-generated': {
          const sentence = packet.payload?.output?.sentence
          if (sentence && !sentence.heartbeat && typeof sentence.text === 'string' && sentence.text.trim()) {
            onSentence(
              offset + Math.max(0, Number(sentence.begin_time || 0)) / 1000,
              sentence.text,
              !!sentence.sentence_end
            )
          }
          break
        }
      }
    } catch {
      fail()
    }
  })

  const { parameters, input } = buildRunTaskPayload(model, meeting)
  socket.addEventListener('open', () => {
    opened = true
    clearTimeout(handshakeTimer)
    socket.send(
      JSON.stringify({
        header: { action: 'run-task', task_id: task, streaming: 'duplex' },
        payload: { task_group: 'audio', task: 'asr', function: 'recognition', model, parameters, input }
      })
    )
  })

  const taskTimer = setTimeout(() => fail(), 20000)
  try {
    await started
  } finally {
    clearTimeout(handshakeTimer)
    clearTimeout(taskTimer)
  }

  let deadline = Date.now()
  let queuedBytes = 0
  let draining = Promise.resolve()

  return {
    push(bytes) {
      if (!ready || failed) return Promise.resolve()
      queuedBytes += bytes.byteLength
      if (queuedBytes > 320000) {
        fail()
        return Promise.resolve()
      }
      draining = draining
        .then(async () => {
          if (failed || done) return
          const delay = Math.max(0, deadline - Date.now())
          if (delay) await new Promise(resolve => setTimeout(resolve, delay))
          if (failed || done) return
          socket.send(bytes)
          const duration = bytes.byteLength / 32
          deadline = Math.max(deadline + duration, Date.now() - duration)
        })
        .catch(() => fail())
        .finally(() => {
          queuedBytes -= bytes.byteLength
        })
      return draining
    },
    async finish() {
      if (done || failed) return
      await draining
      if (done || failed) return
      socket.send(
        JSON.stringify({
          header: { action: 'finish-task', task_id: task, streaming: 'duplex' },
          payload: { input: {} }
        })
      )
      const finishTimer = setTimeout(() => fail(), 30000)
      try {
        await finished
      } finally {
        clearTimeout(finishTimer)
      }
    },
    close: () => fail()
  }
}
