import { $fetch as api } from 'ofetch'
import type { Meeting } from '../../shared/types'

export function useRecorder(onUpdate: (meeting: Meeting) => void, onError: (message: string) => void) {
  const active = ref(false), capturing = ref(false), pending = ref(0), volume = ref(0), elapsed = ref(0)
  let meetingId = '', sequence = 0, context: AudioContext | null = null, node: AudioWorkletNode | null = null
  let source: MediaStreamAudioSourceNode | null = null, stream: MediaStream | null = null
  let queue: ArrayBuffer[] = [], draining: Promise<void> | null = null, flushResolve: (() => void) | null = null
  let batch: { bytes: Uint8Array; count: number } | null = null
  const pendingSeconds = ref(0)
  function updatePending() {
    pending.value = queue.length
    pendingSeconds.value = queue.reduce((bytes, chunk) => bytes + chunk.byteLength, 0) / 32000
  }
  let analyser: AnalyserNode | null = null, frame = 0
  function meter() {
    if (!analyser || !capturing.value) return
    const values = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(values)
    volume.value = Math.min(1, Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length) * 5)
    frame = requestAnimationFrame(meter)
  }
  async function drain() {
    if (draining) return draining
    draining = (async () => {
      while (queue.length) {
        if (!batch) {
          let size = 0, count = 0
          for (const chunk of queue) {
            if (count && size + chunk.byteLength > 32000) break
            size += chunk.byteLength; count++
          }
          const bytes = new Uint8Array(size)
          let offset = 0
          for (const chunk of queue.slice(0, count)) { bytes.set(new Uint8Array(chunk), offset); offset += chunk.byteLength }
          batch = { bytes, count }
        }
        // Keep the exact payload and sequence after a failed request, including a lost acknowledgement.
        await api(`/api/meetings/${meetingId}/audio`, { method: 'POST', body: batch.bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-Audio-Sequence': String(sequence) }, retry: 0, timeout: 15000 })
        queue.splice(0, batch.count); batch = null; sequence++; updatePending()
      }
    })()
    try { await draining } finally { draining = null }
  }
  async function stopCapture() {
    capturing.value = false; cancelAnimationFrame(frame); volume.value = 0
    source?.disconnect()
    stream?.getTracks().forEach(track => track.stop())
    if (node && context?.state === 'running') {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { flushResolve = null; reject(new Error('音频处理器未响应，请重试保存')) }, 3000)
        flushResolve = () => { clearTimeout(timeout); resolve() }
        node!.port.postMessage('flush')
      })
    }
    node?.disconnect(); await context?.close(); context = null; node = null; source = null; stream = null
  }
  async function begin(meeting: Meeting, deviceId: string) {
    if (capturing.value || queue.length) throw new Error('请先保存上一段录音')
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器无法访问麦克风，请使用 HTTPS 或 localhost')
    stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false })
    try {
      context = new AudioContext(); await context.resume(); await context.audioWorklet.addModule('/worklets/pcm.js')
      node = new AudioWorkletNode(context, 'pcm-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
      meetingId = meeting.id; sequence = meeting.nextSeq; elapsed.value = meeting.bytes / 32000
      const updated = await api<Meeting>(`/api/meetings/${meetingId}/state`, { method: 'POST', body: { action: meeting.status === 'ready' ? 'start' : 'resume' } })
      onUpdate(updated); active.value = true; capturing.value = true
      node.port.onmessage = ({ data }) => {
        if (data.type === 'flushed') { flushResolve?.(); flushResolve = null; return }
        if (data.type !== 'pcm') return
        queue.push(data.bytes); updatePending(); elapsed.value += data.bytes.byteLength / 32000
        if (pendingSeconds.value >= 20 && capturing.value) {
          void stopCapture().catch(() => {})
          onError('待上传音频已达到 20 秒，上传速度暂时跟不上录音，已暂停麦克风采集。请重试保存，暂勿刷新页面。')
        }
        void drain().catch(() => onError('录音上传失败，未上传的分块暂存在此页面，请保持页面打开并重试保存。'))
      }
      source = context.createMediaStreamSource(stream); analyser = context.createAnalyser(); analyser.fftSize = 256
      source.connect(analyser); source.connect(node)
      // The processor outputs silence; a connected output keeps it running in browsers.
      node.connect(context.destination); meter()
      stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        if (capturing.value) { void stopCapture().catch(() => {}); onError('麦克风已断开，请重试保存并结束录音。') }
      })
    } catch (error) { await stopCapture().catch(() => {}); throw error }
  }
  async function pause() {
    await stopCapture(); await drain()
    const updated = await api<Meeting>(`/api/meetings/${meetingId}/state`, { method: 'POST', body: { action: 'pause' } })
    onUpdate(updated)
  }
  async function finish() {
    await stopCapture(); await drain()
    const updated = await api<Meeting>(`/api/meetings/${meetingId}/state`, { method: 'POST', body: { action: 'stop' } })
    active.value = false; onUpdate(updated)
  }
  function warn(event: BeforeUnloadEvent) {
    if (active.value || pending.value) { event.preventDefault(); event.returnValue = '' }
  }
  onMounted(() => window.addEventListener('beforeunload', warn))
  onBeforeUnmount(() => { window.removeEventListener('beforeunload', warn); void stopCapture().catch(() => {}) })
  return { active, capturing, pending, pendingSeconds, volume, elapsed, begin, pause, finish, retry: drain }
}
