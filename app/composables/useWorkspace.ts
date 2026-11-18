import { $fetch as api } from 'ofetch'
import type { ConfigTestResult, Meeting, MeetingSummary, UserConfig } from '../../shared/types'

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

export type ConfigTestPayload =
  | {
      service: 'asr'
      aliyunKey?: string
      useSaved: boolean
      aliyunHost: string
      aliyunModel: string
    }
  | {
      service: 'ai'
      deepseekKey?: string
      useSaved: boolean
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
    deepseekModel: 'deepseek-flash',
    encryptionReady: true
  })
  const analyzing = ref(false)
  const analyzingMode = ref<'incremental' | 'full' | null>(null)
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
  let analyzeController: AbortController | null = null
  let lastAutoAnalyzeEndedAt = 0
  let autoAnalyzeBackoffUntil = 0

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

  async function saveSettings(payload: PersonalSettingsPayload, enterWorkspace = false) {
    settingsSaved.value = false
    await run(async () => {
      config.value = await api('/api/config', { method: 'PUT', body: payload })
      settingsSaved.value = !enterWorkspace
      if (enterWorkspace) view.value = 'workspace'
    })
  }

  async function testProviderConfig(payload: ConfigTestPayload): Promise<ConfigTestResult> {
    try {
      return await api<ConfigTestResult>('/api/config/test', { method: 'POST', body: payload })
    } catch (e) {
      return { ok: false, message: extractErrorMessage(e) }
    }
  }

  async function openMeeting(id: string) {
    if (recorder.active.value && id !== selected.value?.id) {
      error.value = '请先结束当前录音再切换会议'
      return
    }
    if (id !== selected.value?.id && analyzeController) {
      analyzeController.abort()
      streaming.value = ''
    }
    await run(async () => {
      selected.value = await api(`/api/meetings/${id}`)
      view.value = 'workspace'
      streaming.value = ''
    })
  }

  async function startNewRecording() {
    if (analyzeController) {
      analyzeController.abort()
      streaming.value = ''
    }
    selected.value = null
    lastAutoAnalyzeEndedAt = Date.now()
    autoAnalyzeBackoffUntil = 0
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
        body: { title, autoAnalyze: config.value.ai }
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
    lastAutoAnalyzeEndedAt = Date.now()
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
    if (analyzeController) {
      analyzeController.abort()
      streaming.value = ''
    }
    let stoppedOk = false
    await run(async () => {
      if (recorder.active.value) await recorder.finish()
      else if (selected.value) {
        selected.value = await api(`/api/meetings/${selected.value.id}/state`, {
          method: 'POST',
          body: { action: 'stop' }
        })
      }
      await refreshList()
      stoppedOk = true
    })
    if (stoppedOk && config.value.ai && selected.value?.autoAnalyze && selected.value.segments.length > 0) {
      await analyzeMeeting(true)
    }
  }

  async function toggleAutoAnalyze(enabled: boolean) {
    if (!selected.value) return
    autoAnalyzeBackoffUntil = 0
    await run(async () => {
      selected.value = await api(`/api/meetings/${selected.value!.id}/auto-analyze`, {
        method: 'POST',
        body: { enabled }
      })
    })
    if (enabled) maybeAutoAnalyze()
  }

  async function analyzeMeeting(final = true, options: { silent?: boolean } = {}) {
    if (analyzing.value || !selected.value || !config.value.ai || !selected.value.segments.length) return
    const id = selected.value.id
    const isIncremental =
      !final &&
      selected.value.analyses.length > 0 &&
      selected.value.analyzedCount > 0 &&
      selected.value.analyzedCount < selected.value.segments.length
    analyzing.value = true
    analyzingMode.value = isIncremental ? 'incremental' : 'full'
    streaming.value = ''
    if (!options.silent) error.value = ''

    const controller = new AbortController()
    analyzeController = controller
    try {
      const response = await fetch(`/api/meetings/${id}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ final }),
        signal: controller.signal
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
      autoAnalyzeBackoffUntil = 0
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return
      error.value = extractErrorMessage(e)
      streaming.value = ''
      if (options.silent) autoAnalyzeBackoffUntil = Date.now() + 60000
    } finally {
      lastAutoAnalyzeEndedAt = Date.now()
      if (analyzeController === controller) analyzeController = null
      analyzing.value = false
      analyzingMode.value = null
    }
  }

  function maybeAutoAnalyze() {
    if (!ready.value || analyzing.value || busy.value || !config.value.ai || !selected.value) return
    const current = selected.value
    if (!current.autoAnalyze || current.status !== 'recording') return
    if (Date.now() < autoAnalyzeBackoffUntil) return

    const delta = current.segments.length - current.analyzedCount
    if (delta <= 0) return

    const elapsedSinceLast = Date.now() - lastAutoAnalyzeEndedAt
    const shouldStart =
      (current.analyses.length === 0 && delta >= 2 && elapsedSinceLast >= 8000) ||
      (elapsedSinceLast >= 20000 && delta >= 1) ||
      (elapsedSinceLast >= 10000 && delta >= 5)

    if (shouldStart) {
      void analyzeMeeting(false, { silent: true })
    }
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
      maybeAutoAnalyze()
    } catch (e) {
      error.value = extractErrorMessage(e)
    } finally {
      polling = false
    }
  }

  async function initializeWorkspace() {
    await run(async () => {
      await api('/api/workspace', { method: 'POST' })
      await loadInitialData()
      if (!config.value.asr && !config.value.ai) {
        view.value = 'settings'
      }
      ready.value = true
    })
  }

  onMounted(() => {
    void initializeWorkspace()
    poll = setInterval(() => void tick(), 1500)
  })

  onBeforeUnmount(() => {
    clearInterval(poll)
    analyzeController?.abort()
  })

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
    analyzingMode,
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
    testProviderConfig,
    openMeeting,
    startNewRecording,
    loadMicrophones,
    record,
    pause,
    retryUpload,
    finish,
    toggleAutoAnalyze,
    analyzeMeeting
  }
}
