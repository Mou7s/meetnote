import type { Meeting } from '../shared/types'
import { isSupportedAliyunHost, type ProviderSettings } from './settings'

export interface Asr { push: (bytes: ArrayBuffer) => Promise<void>; finish: () => Promise<void>; close: () => void }
export async function connectAsr(env: ProviderSettings, meeting: Meeting, onSentence: (time: number, text: string, final: boolean) => void, onFailure: () => void): Promise<Asr | null> {
  if (!env.ALIYUN_API_KEY) return null
  const host = env.ALIYUN_HOST
  if (!isSupportedAliyunHost(host)) throw new Error('百炼 API Host 无效')
  const model: string = env.ALIYUN_MODEL
  if (!['qwen-audio-3.1-asr-flash-streaming', 'fun-asr-realtime', 'paraformer-realtime-v2'].includes(model)) throw new Error('百炼模型配置无效')
  let response: Response
  const handshake = new AbortController()
  const handshakeTimer = setTimeout(() => handshake.abort(), 20000)
  try {
    response = await fetch(`https://${host}/api-ws/v1/inference`, { headers: { Upgrade: 'websocket', Authorization: `Bearer ${env.ALIYUN_API_KEY}` }, signal: handshake.signal })
  } catch {
    throw new Error('无法连接百炼 WebSocket，请检查 API Host 与网络。')
  } finally { clearTimeout(handshakeTimer) }
  const socket = response.webSocket
  if (response.status !== 101 || !socket) {
    await response.body?.cancel().catch(() => {})
    if (response.status === 401 || response.status === 403) throw new Error(`百炼拒绝了 API Key（HTTP ${response.status}）。请确认密钥完整且启用，并且 API Host 与密钥地域/业务空间一致。`)
    throw new Error(`百炼 WebSocket 握手失败（HTTP ${response.status}），请检查 API Host、模型权限或网络。`)
  }
  socket.accept()
  const task = crypto.randomUUID().replaceAll('-', ''), offset = meeting.bytes / 32000
  let ready = false, done = false, failed = false, finishResolve: () => void = () => {}
  let startResolve: () => void = () => {}, startReject: (error: Error) => void = () => {}
  const started = new Promise<void>((resolve, reject) => { startResolve = resolve; startReject = reject })
  const finished = new Promise<void>(resolve => { finishResolve = resolve })
  const fail = () => {
    if (failed || done) return
    failed = true; ready = false; onFailure(); startReject(new Error('百炼任务失败')); finishResolve()
    try { socket.close(1011, 'ASR failed') } catch { /* Already closed. */ }
  }
  socket.addEventListener('error', fail)
  socket.addEventListener('close', () => { if (!done) fail() })
  socket.addEventListener('message', event => {
    try {
      const packet = JSON.parse(String(event.data))
      switch (packet.header?.event) {
        case 'task-started': ready = true; startResolve(); break
        case 'task-finished': done = true; ready = false; finishResolve(); socket.close(1000); break
        case 'task-failed': fail(); break
        case 'result-generated': {
          const sentence = packet.payload?.output?.sentence
          if (sentence && !sentence.heartbeat && typeof sentence.text === 'string' && sentence.text.trim()) onSentence(offset + Math.max(0, Number(sentence.begin_time || 0)) / 1000, sentence.text, !!sentence.sentence_end)
          break
        }
      }
    } catch { fail() }
  })
  const parameters: Record<string, unknown> = { format: 'pcm', sample_rate: 16000, language_hints: ['zh'] }
  let input = {}
  if (model === 'qwen-audio-3.1-asr-flash-streaming') {
    parameters.vad_model = 'far_field_meeting_16k'; parameters.heartbeat = true
    parameters.vocabulary = Object.fromEntries(meeting.terms.split(/[\r\n,，;；]+/).map(s => s.trim()).filter(Boolean).map(s => [s, 3]))
    if (meeting.context) input = { context: [{ role: 'user', content: [{ type: 'input_text', text: meeting.context }] }] }
  }
  if (model === 'paraformer-realtime-v2') { parameters.semantic_punctuation_enabled = true; parameters.heartbeat = true }
  socket.send(JSON.stringify({ header: { action: 'run-task', task_id: task, streaming: 'duplex' }, payload: { task_group: 'audio', task: 'asr', function: 'recognition', model, parameters, input } }))
  const timer = setTimeout(fail, 20000)
  try { await started } finally { clearTimeout(timer) }
  let deadline = Date.now(), queuedBytes = 0, draining = Promise.resolve()
  return {
    push(bytes) {
      if (!ready || failed) return Promise.resolve()
      queuedBytes += bytes.byteLength
      if (queuedBytes > 320000) { fail(); return Promise.resolve() }
      draining = draining.then(async () => {
        if (failed || done) return
        const delay = Math.max(0, deadline - Date.now())
        if (delay) await new Promise(resolve => setTimeout(resolve, delay))
        if (failed || done) return
        socket.send(bytes)
        const duration = bytes.byteLength / 32
        deadline = Math.max(deadline + duration, Date.now() - duration)
      }).catch(fail).finally(() => { queuedBytes -= bytes.byteLength })
      return draining
    },
    async finish() {
      if (done || failed) return
      await draining
      if (done || failed) return
      socket.send(JSON.stringify({ header: { action: 'finish-task', task_id: task, streaming: 'duplex' }, payload: { input: {} } }))
      const timer = setTimeout(fail, 30000)
      try { await finished } finally { clearTimeout(timer) }
    },
    close: fail
  }
}
