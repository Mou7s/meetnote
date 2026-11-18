import { $fetch as api } from 'ofetch'
import type { Meeting, MeetingSummary, UserConfig } from '../../shared/types'

export type WorkspaceView = 'workspace' | 'history' | 'settings'

export interface PersonalSettingsPayload {
  aliyunKey: string
  deepseekKey: string
  clearAliyun: boolean
  clearDeepseek: boolean
  aliyunHost: string
  aliyunModel: string
  deepseekModel: string
}

export function useWorkspace() {
  const ready = ref(false)
  const view = ref<WorkspaceView>('workspace')
  const meetings = ref<MeetingSummary[]>([])
  const selected = ref<Meeting | null>(null)
  const error = ref('')
  const busy = ref(false)
  const device = ref('')
  const devices = ref<MediaDeviceInfo[]>([])
  const config = ref<UserConfig>({
    asr: false,
    ai: false,
    aliyunHost: 'dashscope.aliyuncs.com',
    aliyunModel: 'qwen-audio-3.1-asr-flash-streaming',
    deepseekModel: 'deepseek-flash'
  })
  const analyzing = ref(false)
  const streaming = ref('')
  const follow = ref(true)
  const settingsSaved = ref(false)

  const recorder = useRecorder(
    meeting => {
      selected.value = meeting
    },
    msg => {
      error.value = msg
    }
  )

  let poll: ReturnType<typeof setInterval> | undefined
  let polling = false

  async function run(action: () => Promise<unknown>) {
    if (busy.value) return
    busy.value = true
    error.value = ''
    try {
      await action()
    } catch (e) {
      error.value = extractErrorMessage(e)
    } finally {
      busy.value = false
    }
  }

  async function refreshList() {
    meetings.value = await api('/api/meetings')
  }

  async function loadInitialData() {
    await Promise.all([
      refreshList(),
      api<UserConfig>('/api/config').then(value => {
        config.value = value
      })
    ])
  }

  async function showSettings() {
    if (recorder.active.value || analyzing.value) return
    await run(async () => {
      config.value = await api('/api/config')
      settingsSaved.value = false
      view.value = 'settings'
    })
  }

  async function saveSettings(payload: PersonalSettingsPayload) {
    settingsSaved.value = false
    await run(async () => {
      config.value = await api('/api/config', { method: 'PUT', body: payload })
      settingsSaved.value = true
      view.value = 'workspace'
    })
  }

  async function openMeeting(id: string) {
    if (recorder.active.value && id !== selected.value?.id) {
      error.value = '请先结束当前录音再切换会议'
      return
    }
    await run(async () => {
      selected.value = await api(`/api/meetings/${id}`)
      view.value = 'workspace'
      streaming.value = ''
    })
  }

  async function startNewRecording() {
    selected.value = null
    await run(async () => {
      const now = new Date()
      const title = `录音 ${now.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      })}`
      const meeting = await api<Meeting>('/api/meetings', {
        method: 'POST',
        body: { title, autoAnalyze: false }
      })
      selected.value = meeting
      view.value = 'workspace'
      try {
        await recorder.begin(meeting, device.value)
        await refreshList()
      } catch (err) {
        await refreshList()
        throw err
      }
    })
  }

  async function loadMicrophones() {
    await run(async () => {
      if (!navigator.mediaDevices) throw new Error('请通过 HTTPS 或 localhost 访问以启用麦克风')
      const permission = await navigator.mediaDevices.getUserMedia({ audio: true })
      try {
        devices.value = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput')
      } finally {
        permission.getTracks().forEach(t => t.stop())
      }
    })
  }

  async function record() {
    if (!selected.value) return
    await run(async () => {
      await recorder.begin(selected.value!, device.value)
      await refreshList()
    })
  }

  async function pause() {
    await run(async () => {
      await recorder.pause()
      await refreshList()
    })
  }

  async function retryUpload() {
    await run(recorder.retry)
  }

  async function finish() {
    await run(async () => {
      if (recorder.active.value) await recorder.finish()
      else if (selected.value) {
        selected.value = await api(`/api/meetings/${selected.value.id}/state`, {
          method: 'POST',
          body: { action: 'stop' }
        })
      }
      await refreshList()
    })
  }

  async function analyzeMeeting() {
    if (analyzing.value || !selected.value) return
    analyzing.value = true
    streaming.value = ''
    error.value = ''
    const id = selected.value.id
    try {
      const response = await fetch(`/api/meetings/${id}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ final: true })
      })
      if (!response.ok || !response.body) {
        const body = (await response.json()) as { statusMessage?: string }
        throw new Error(body.statusMessage || '分析请求失败')
      }
      let buffer = ''
      let complete = false
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      while (true) {
        const { done: ended, value: chunk } = await reader.read()
        if (ended) break
        buffer += chunk.replaceAll('\r\n', '\n')
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const packet = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const kind = packet.split('\n').find(l => l.startsWith('event:'))?.slice(6).trim()
          const data = packet
            .split('\n')
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).trim())
            .join('\n')
          if (!data) continue
          const value = JSON.parse(data)
          if (kind === 'failure') throw new Error(value.message)
          if (kind === 'delta' && selected.value?.id === id) streaming.value += value.text
          if (kind === 'done') complete = true
        }
      }
      if (!complete) throw new Error('分析连接中断，已保留之前的完整记录')
      if (selected.value?.id === id) {
        selected.value = await api(`/api/meetings/${id}`)
        streaming.value = ''
      }
    } catch (e) {
      error.value = extractErrorMessage(e)
      streaming.value = ''
    } finally {
      analyzing.value = false
    }
  }

  async function markSegment(segmentId: string) {
    if (!selected.value) return
    await run(async () => {
      selected.value = await api(`/api/meetings/${selected.value!.id}/mark`, {
        method: 'POST',
        body: { segmentId }
      })
    })
  }

  async function tick() {
    if (!ready.value || polling) return
    const id = selected.value?.id
    if (!id || busy.value) return
    polling = true
    try {
      const meeting = await api<Meeting>(`/api/meetings/${id}`)
      if (selected.value?.id !== id || busy.value) return
      selected.value = meeting
      if (recorder.active.value && !recorder.capturing.value && meeting.status === 'recording') return
    } catch (e) {
      error.value = extractErrorMessage(e)
    } finally {
      polling = false
    }
  }

  async function initializeWorkspace() {
    await run(async () => {
      await api('/api/workspace', { method: 'POST' })
      ready.value = true
      await loadInitialData()
      if (!config.value.asr && !config.value.ai) {
        view.value = 'settings'
      }
    })
  }

  onMounted(() => {
    void initializeWorkspace()
    poll = setInterval(() => void tick(), 1500)
  })

  onBeforeUnmount(() => clearInterval(poll))

  return {
    ready,
    view,
    meetings,
    selected,
    error,
    busy,
    device,
    devices,
    config,
    analyzing,
    streaming,
    follow,
    settingsSaved,
    active: recorder.active,
    capturing: recorder.capturing,
    pending: recorder.pending,
    pendingSeconds: recorder.pendingSeconds,
    volume: recorder.volume,
    elapsed: recorder.elapsed,
    initializeWorkspace,
    refreshList: () => run(refreshList),
    showSettings,
    saveSettings,
    openMeeting,
    startNewRecording,
    loadMicrophones,
    record,
    pause,
    retryUpload,
    finish,
    analyzeMeeting,
    markSegment
  }
}
