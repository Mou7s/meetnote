<script setup lang="ts">
import { $fetch as api } from 'ofetch'
import type { Meeting, UserConfig } from '../shared/types'

const ready = ref(false)
const view = ref<'workspace' | 'history' | 'settings'>('workspace')
const meetings = ref<(Omit<Meeting, 'segments' | 'analyses'> & { segmentCount: number; analysisCount: number })[]>([])
const selected = ref<Meeting | null>(null)
const error = ref(''), busy = ref(false)
const device = ref(''), devices = ref<MediaDeviceInfo[]>([])
const config = ref<UserConfig>({ asr: false, ai: false, aliyunHost: 'dashscope.aliyuncs.com', aliyunModel: 'qwen-audio-3.1-asr-flash-streaming', deepseekModel: 'deepseek-flash' }), analyzing = ref(false), streaming = ref(''), follow = ref(true)
const personal = reactive({ aliyunKey: '', deepseekKey: '', clearAliyun: false, clearDeepseek: false, aliyunHost: '', aliyunModel: '', deepseekModel: '' })
const settingsSaved = ref(false)
const transcriptPanel = ref<HTMLElement | null>(null), analysisPanel = ref<HTMLElement | null>(null)
const recorder = useRecorder(meeting => { selected.value = meeting }, message => { error.value = message })
const { active, capturing, pending, pendingSeconds, volume, elapsed } = recorder
const pageTitle = computed(() => view.value === 'history' ? '会议记录' : view.value === 'settings' ? '个人设置' : '会议工作台')
let poll: ReturnType<typeof setInterval> | undefined
let polling = false
const statusLabel: Record<Meeting['status'], string> = { ready: '待开始', recording: '录音中', paused: '已暂停', completed: '已结束', interrupted: '已中断' }
const duration = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const message = (e: unknown) => {
  const failure = e as { data?: { statusMessage?: string; message?: string }; message?: string }
  return failure.data?.statusMessage || failure.data?.message || failure.message || '操作失败，请重试'
}
async function run(action: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await action() } catch (e) { error.value = message(e) } finally { busy.value = false }
}
async function refreshList() { meetings.value = await api('/api/meetings') }
async function load() { await Promise.all([refreshList(), api<typeof config.value>('/api/config').then(value => { config.value = value })]) }
async function showSettings() {
  if (active.value || analyzing.value) return
  await run(async () => {
    config.value = await api('/api/config')
    Object.assign(personal, { aliyunKey: '', deepseekKey: '', clearAliyun: false, clearDeepseek: false, aliyunHost: config.value.aliyunHost, aliyunModel: config.value.aliyunModel, deepseekModel: config.value.deepseekModel })
    settingsSaved.value = false; view.value = 'settings'
  })
}
const navItems = computed(() => [
  { label: '会议工作台', icon: 'i-lucide-layout-dashboard', active: view.value === 'workspace', onSelect: () => { view.value = 'workspace' } },
  { label: '会议记录', icon: 'i-lucide-history', badge: meetings.value.length, disabled: active.value, active: view.value === 'history', onSelect: () => { view.value = 'history'; void run(refreshList) } },
  { label: '个人设置', icon: 'i-lucide-settings-2', disabled: active.value || analyzing.value, active: view.value === 'settings', onSelect: () => { void showSettings() } }
])
async function saveSettings() {
  settingsSaved.value = false
  await run(async () => {
    config.value = await api('/api/config', { method: 'PUT', body: personal })
    personal.aliyunKey = ''; personal.deepseekKey = ''; personal.clearAliyun = false; personal.clearDeepseek = false; settingsSaved.value = true; view.value = 'workspace'
  })
}
async function openMeeting(id: string) {
  if (active.value && id !== selected.value?.id) { error.value = '请先结束当前录音再切换会议'; return }
  await run(async () => { selected.value = await api(`/api/meetings/${id}`); view.value = 'workspace'; streaming.value = '' })
}
async function startNewRecording() {
  await run(async () => {
    const now = new Date()
    const title = `录音 ${now.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}`
    const meeting = await api<Meeting>('/api/meetings', { method: 'POST', body: { title, autoAnalyze: false } })
    selected.value = meeting
    view.value = 'workspace'
    try {
      await recorder.begin(meeting, device.value)
      await refreshList()
    } catch (error) {
      await refreshList()
      throw error
    }
  })
}
async function microphones() {
  await run(async () => {
    if (!navigator.mediaDevices) throw new Error('请通过 HTTPS 或 localhost 访问以启用麦克风')
    const permission = await navigator.mediaDevices.getUserMedia({ audio: true })
    try { devices.value = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput') } finally { permission.getTracks().forEach(t => t.stop()) }
  })
}
async function record() {
  if (!selected.value) return
  await run(async () => { await recorder.begin(selected.value!, device.value); await refreshList() })
}
async function pause() { await run(async () => { await recorder.pause(); await refreshList() }) }
async function finish() {
  await run(async () => {
    if (active.value) await recorder.finish()
    else if (selected.value) selected.value = await api(`/api/meetings/${selected.value.id}/state`, { method: 'POST', body: { action: 'stop' } })
    await refreshList()
  })
}
async function analyzeMeeting() {
  if (analyzing.value || !selected.value) return
  analyzing.value = true; streaming.value = ''; error.value = ''
  const id = selected.value.id
  try {
    const response = await fetch(`/api/meetings/${id}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ final: true }) })
    if (!response.ok || !response.body) { const body = await response.json() as { statusMessage?: string }; throw new Error(body.statusMessage || '分析请求失败') }
    let buffer = '', complete = false
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    while (true) {
      const { done: ended, value: chunk } = await reader.read()
      if (ended) break
      buffer += chunk.replaceAll('\r\n', '\n')
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const packet = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        const kind = packet.split('\n').find(l => l.startsWith('event:'))?.slice(6).trim()
        const data = packet.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
        if (!data) continue
        const value = JSON.parse(data)
        if (kind === 'failure') throw new Error(value.message)
        if (kind === 'delta' && selected.value?.id === id) streaming.value += value.text
        if (kind === 'done') complete = true
      }
    }
    if (!complete) throw new Error('分析连接中断，已保留之前的完整记录')
    if (selected.value?.id === id) { selected.value = await api(`/api/meetings/${id}`); streaming.value = '' }
  } catch (e) { error.value = message(e); streaming.value = '' }
  finally { analyzing.value = false }
}
async function mark(segmentId: string) {
  if (!selected.value) return
  await run(async () => { selected.value = await api(`/api/meetings/${selected.value!.id}/mark`, { method: 'POST', body: { segmentId } }) })
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
    if (active.value && !capturing.value && meeting.status === 'recording') return

  } catch (e) { error.value = message(e) } finally { polling = false }
}
watch(() => [selected.value?.segments.length, selected.value?.interim?.text], async () => { if (follow.value) { await nextTick(); transcriptPanel.value?.scrollTo({ top: transcriptPanel.value.scrollHeight, behavior: 'smooth' }) } })
watch([streaming, () => selected.value?.analyses.length], async () => { if (follow.value) { await nextTick(); analysisPanel.value?.scrollTo({ top: analysisPanel.value.scrollHeight, behavior: 'smooth' }) } })
async function initializeWorkspace() {
  await run(async () => {
    await api('/api/workspace', { method: 'POST' })
    ready.value = true
    await load()
    if (!config.value.asr && !config.value.ai) {
      Object.assign(personal, { aliyunHost: config.value.aliyunHost, aliyunModel: config.value.aliyunModel, deepseekModel: config.value.deepseekModel })
      view.value = 'settings'
    }
  })
}
onMounted(() => {
  void initializeWorkspace()
  poll = setInterval(() => void tick(), 1500)
})
onBeforeUnmount(() => clearInterval(poll))
</script>

<template>
  <UApp>
    <UDashboardGroup class="shell" storage="local" storage-key="meetnote-dashboard">
      <UDashboardSidebar class="sidebar" :toggle="false" :default-size="17" :min-size="14" :max-size="20">
        <template #header>
          <div class="brand"><span class="brand-symbol"><UIcon name="i-lucide-audio-lines" /></span><span>MeetNote</span></div>
        </template>
        <template #default>
          <p class="nav-label">工作空间</p>
          <UNavigationMenu :items="navItems" orientation="vertical" color="primary" variant="pill" highlight highlight-color="primary" class="workspace-nav" :ui="{ list: 'gap-1', link: 'rounded-lg px-3 py-2.5', linkLeadingIcon: 'size-4' }" />
          <div class="recent-heading"><p class="nav-label">最近会议</p><UBadge color="neutral" variant="subtle" size="xs">{{ meetings.length }}</UBadge></div>
          <div v-if="meetings.length" class="recent-list"><UButton v-for="meeting in meetings.slice(0, 6)" :key="meeting.id" color="neutral" variant="ghost" size="sm" block class="recent-item" :class="{ 'recent-active': selected?.id === meeting.id }" @click="openMeeting(meeting.id)"><span class="recent-dot" :class="{ live: meeting.status === 'recording' }" /><span class="recent-title">{{ meeting.title }}</span></UButton></div>
          <p v-else class="sidebar-empty">录音完成后会显示在这里。</p>
        </template>
      </UDashboardSidebar>
      <UDashboardPanel class="main">
        <template #header>
          <UDashboardNavbar :title="pageTitle" class="topbar">
            <template #right><UBadge color="success" variant="subtle" class="server-state"><span class="server-dot" /> 云端存储已连接</UBadge></template>
          </UDashboardNavbar>
        </template>
        <template #body>
          <div class="content">
          <UAlert v-if="error" color="error" variant="soft" :description="error" class="notice" close @update:open="error = ''" />
          <div v-if="!ready" class="empty-history">正在准备工作台…<UButton v-if="error" :loading="busy" @click="initializeWorkspace">重试</UButton></div><template v-else-if="view === 'workspace'">
            <div class="page-heading"><div><span class="eyebrow">MEETING STUDIO</span><h1>{{ selected ? selected.title : '让每次讨论，都有记录。' }}</h1><p class="muted">{{ selected ? `${date(selected.created)} · ${statusLabel[selected.status]}` : '准备好后直接开始录音，转写自动保存，需要时可手动总结。' }}</p></div><UButton v-if="selected && !active && !analyzing" icon="i-lucide-mic" @click="selected = null; startNewRecording()">开始新录音</UButton></div>
            <section v-if="!selected" class="launch-wrap">
              <UCard class="launch-card">
                <div class="launch-icon"><UIcon name="i-lucide-mic" /></div>
                <UBadge color="neutral" variant="soft">{{ config.asr ? '实时转写已就绪' : '录音可用 · 转写待配置' }}</UBadge>
                <h2>准备好就开始</h2>
                <p>点击后立即开始录音，系统会按开始时间自动命名并保存这段记录。</p>
                <UButton size="xl" icon="i-lucide-mic" :loading="busy" :disabled="analyzing" @click="startNewRecording">开始录音</UButton>
                <div class="launch-services">
                  <span><UIcon :name="config.asr ? 'i-lucide-circle-check' : 'i-lucide-circle-dashed'" /> 百炼转写 {{ config.asr ? '已连接' : '未配置' }}</span>
                  <span><UIcon :name="config.ai ? 'i-lucide-circle-check' : 'i-lucide-circle-dashed'" /> DeepSeek 分析 {{ config.ai ? '已连接' : '未配置' }}</span>
                </div>
              </UCard>
              <p class="launch-hint"><UIcon name="i-lucide-shield-check" /> 录音保存在你的独立工作空间中。云端转写会将音频发送至你配置的百炼服务。</p>
            </section>
            <template v-else>
              <UAlert v-if="selected.error" color="warning" variant="soft" :description="selected.error" class="notice" />
              <div class="recording-bar"><div class="recording-clock"><span class="record-dot" :class="{ pulse: capturing }" /><strong>{{ duration(active ? elapsed : selected.bytes / 32000) }}</strong><span>{{ capturing ? '正在录音' : statusLabel[selected.status] }}</span></div><div v-if="active" class="meter" aria-label="麦克风音量"><span :style="{ width: `${volume * 100}%` }" /></div><span v-if="pending" class="pending">{{ pendingSeconds.toFixed(1) }} 秒待上传</span><div class="recording-actions"><template v-if="['ready', 'paused', 'interrupted'].includes(selected.status)"><select v-model="device" aria-label="选择麦克风"><option value="">默认麦克风</option><option v-for="(mic, index) in devices" :key="mic.deviceId" :value="mic.deviceId">{{ mic.label || `麦克风 ${index + 1}` }}</option></select><UButton color="neutral" variant="ghost" :disabled="busy" @click="microphones">选择设备</UButton><UButton :loading="busy" :disabled="analyzing" @click="record">{{ selected.status === 'ready' ? '开始录音' : '继续录音' }}</UButton></template><UButton v-if="capturing" color="neutral" variant="outline" :loading="busy" @click="pause">暂停</UButton><UButton v-if="pending && !capturing" color="warning" variant="outline" :loading="busy" @click="run(recorder.retry)">重试保存</UButton><UButton v-if="['recording', 'paused', 'interrupted'].includes(selected.status)" color="neutral" :loading="busy" :disabled="analyzing" @click="finish">结束并保存</UButton></div></div>
              <div class="studio-grid"><section class="studio-panel"><header><div><span class="panel-icon">≋</span><h2>实时转写</h2><UBadge color="neutral" variant="soft">{{ selected.segments.length }} 段</UBadge></div><span class="small muted">点击 ☆ 标记重点</span></header><div ref="transcriptPanel" class="panel-body transcript"><div v-if="!selected.segments.length && !selected.interim" class="empty-state"><span class="empty-icon">≋</span><h3>{{ capturing ? '正在聆听你的会议…' : '对话，从这里留下来' }}</h3><p>{{ config.asr ? '开始录音后，确认的转写将出现在这里。' : '在个人设置中填写自己的百炼密钥，即可使用实时转写。' }}</p></div><article v-for="segment in selected.segments" :key="segment.id" class="segment" :class="{ marked: segment.marked }"><div><time>{{ duration(segment.time) }}</time><button :aria-label="segment.marked ? '取消重点' : '标记重点'" :aria-pressed="segment.marked" @click="mark(segment.id)">{{ segment.marked ? '★' : '☆' }}</button></div><p>{{ segment.text }}</p></article><article v-if="selected.interim" class="segment streaming" aria-live="polite"><div><time>{{ duration(selected.interim.time) }}</time><UBadge color="primary" variant="soft">正在识别</UBadge></div><p>{{ selected.interim.text }}</p></article></div><footer><span class="small muted">{{ capturing ? '确认转写自动保存' : '录音与转写保存在服务器' }}</span><UCheckbox v-model="follow" label="跟随最新" /></footer></section>
              <section class="studio-panel analysis"><header><div><span class="panel-icon">✧</span><h2>AI 会议洞察</h2></div></header><div ref="analysisPanel" class="panel-body"><div v-if="!selected.analyses.length && !analyzing" class="empty-state"><span class="empty-icon">✧</span><h3>把讨论，变成清晰的下一步</h3><p>提炼要点、整理决定、追踪待办。<br>点击“立即分析”，总结左侧全部已确认转写。</p></div><article v-for="analysis in selected.analyses" :key="analysis.id" class="analysis-entry"><div class="analysis-meta"><UBadge :color="analysis.final ? 'primary' : 'neutral'" variant="soft">{{ analysis.final ? '全文总结' : '历史分析' }}</UBadge><time>{{ date(analysis.created) }}</time></div><p>{{ analysis.text }}</p></article><article v-if="analyzing" class="analysis-entry streaming"><div class="analysis-meta">✧ 正在整理思路…</div><p>{{ streaming || '等待分析内容…' }}</p></article></div><footer><span class="small muted">{{ config.ai ? '基于确认转写 · 请核对关键信息' : '请在个人设置中配置 DeepSeek' }}</span><UButton size="sm" variant="soft" :loading="analyzing" :disabled="!config.ai || !selected.segments.length || busy" @click="analyzeMeeting()">立即分析</UButton></footer></section></div>
              <div v-if="selected.bytes && !active" class="playback"><span>会议录音</span><audio controls preload="none" :src="`/api/meetings/${selected.id}/audio`" /><UButton :href="`/api/meetings/${selected.id}/audio`" :download="`${selected.title}.wav`" color="neutral" variant="outline">下载录音</UButton><UButton :href="`/api/meetings/${selected.id}/export`" color="neutral" variant="ghost">导出会议</UButton></div>
              <p class="footnote">录音期间请保持页面打开。云端转写与 AI 分析可能产生服务商费用。</p>
            </template>
          </template>
          <template v-else-if="view === 'history'"><div class="page-heading"><div><span class="eyebrow">YOUR CONVERSATIONS</span><h1>会议记录</h1><p class="muted">回到讨论现场，找到每一个决定。</p></div><UButton icon="i-lucide-mic" :loading="busy" @click="selected = null; startNewRecording()">开始录音</UButton></div><div v-if="!meetings.length" class="empty-history">还没有录音记录。点击“开始录音”即可开始。</div><button v-for="meeting in meetings" :key="meeting.id" class="history-row" @click="openMeeting(meeting.id)"><div class="history-icon">◫</div><div class="history-title"><strong>{{ meeting.title }}</strong><small>{{ date(meeting.created) }} · {{ meeting.segmentCount }} 段转写 · {{ meeting.analysisCount }} 次分析</small></div><span>{{ duration(meeting.bytes / 32000) }}</span><UBadge color="neutral" variant="soft">{{ statusLabel[meeting.status] }}</UBadge><span>↗</span></button></template>
          <template v-else-if="view === 'settings'">
            <div class="page-heading"><div><span class="eyebrow">OPEN. CONNECT. START.</span><h1>填入密钥，开始你的会议。</h1><p class="muted">无需注册或登录。连接自己的模型服务，调用费用由你的服务商账号承担。</p></div></div>
            <UAlert v-if="settingsSaved" color="success" variant="soft" description="个人设置已保存，下一次录音或分析时生效。" class="notice" />
            <form class="personal-settings" @submit.prevent="saveSettings">
              <section class="settings-card"><div class="settings-heading"><div><span class="eyebrow">01 / TRANSCRIPTION</span><h2>百炼 · 实时转写</h2></div><UBadge :color="config.asr ? 'success' : 'neutral'" variant="soft">{{ config.asr ? '已保存个人密钥' : '未配置' }}</UBadge></div><UFormField label="百炼 API Key"><UInput v-model="personal.aliyunKey" type="text" autocomplete="off" autocapitalize="none" :spellcheck="false" data-1p-ignore data-lpignore="true" class="full" :placeholder="config.asr ? '已保存，留空保留；填写新密钥可替换' : '填写你自己的百炼 API Key'" maxlength="512" /></UFormField><UFormField label="百炼 API Host"><UInput v-model="personal.aliyunHost" class="full" placeholder="填写百炼创建密钥时显示的 API Host" required /></UFormField><UFormField label="识别模型"><select v-model="personal.aliyunModel" class="full"><option value="qwen-audio-3.1-asr-flash-streaming">qwen-audio-3.1-asr-flash-streaming</option><option value="fun-asr-realtime">fun-asr-realtime</option><option value="paraformer-realtime-v2">paraformer-realtime-v2</option></select></UFormField><UCheckbox v-if="config.asr" v-model="personal.clearAliyun" label="保存时移除已存的百炼密钥" /><p class="muted">密钥与 API Host 必须来自同一地域和业务空间；新加坡可使用 dashscope-intl.aliyuncs.com 或对应的业务空间 Host。在线转写会将麦克风音频发送至你配置的百炼服务。</p></section>
              <section class="settings-card"><div class="settings-heading"><div><span class="eyebrow">02 / MEETING INSIGHTS</span><h2>DeepSeek · AI 分析</h2></div><UBadge :color="config.ai ? 'success' : 'neutral'" variant="soft">{{ config.ai ? '已保存个人密钥' : '未配置' }}</UBadge></div><UFormField label="DeepSeek API Key"><UInput v-model="personal.deepseekKey" type="text" autocomplete="off" autocapitalize="none" :spellcheck="false" data-1p-ignore data-lpignore="true" class="full" :placeholder="config.ai ? '已保存，留空保留；填写新密钥可替换' : '填写你自己的 DeepSeek API Key'" maxlength="512" /></UFormField><UFormField label="分析模型"><UInput v-model="personal.deepseekModel" class="full" required maxlength="100" /></UFormField><UCheckbox v-if="config.ai" v-model="personal.clearDeepseek" label="保存时移除已存的 DeepSeek 密钥" /><p class="muted">AI 分析发送确认转写文字，不发送原始音频。</p></section>
              <div class="settings-footer"><p>密钥加密保存，保存后不回显；通过当前浏览器的独立标识访问。<br>请求经本站服务端转发，站点服务在调用时会解密使用。</p><UButton type="submit" size="lg" :loading="busy">保存并进入工作台</UButton><UButton color="neutral" variant="ghost" @click="view = 'workspace'">先进入工作台，仅录音</UButton></div>
            </form>
          </template>
          </div>
        </template>
      </UDashboardPanel>
    </UDashboardGroup>
  </UApp>
</template>
