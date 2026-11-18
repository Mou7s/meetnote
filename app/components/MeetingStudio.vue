<script setup lang="ts">
import type { Meeting, UserConfig } from '../../shared/types'

const props = defineProps<{
  selected: Meeting
  config: UserConfig
  busy: boolean
  analyzing: boolean
  analyzingMode: 'incremental' | 'full' | null
  streaming: string
  active: boolean
  capturing: boolean
  pending: number
  pendingSeconds: number
  volume: number
  elapsed: number
  devices: MediaDeviceInfo[]
  device: string
  follow: boolean
}>()

const emit = defineEmits<{
  'update:device': [value: string]
  'update:follow': [value: boolean]
  loadMicrophones: []
  record: []
  pause: []
  retry: []
  finish: []
  toggleAutoAnalyze: [enabled: boolean]
  analyze: [final: boolean]
}>()

const transcriptPanel = ref<HTMLElement | null>(null)
const analysisPanel = ref<HTMLElement | null>(null)
const showHistory = ref(false)
const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | undefined

const DEFAULT_MIC_VALUE = '__default__'

const deviceOptions = computed(() => [
  { label: '默认麦克风', value: DEFAULT_MIC_VALUE },
  ...props.devices.map((mic, index) => ({
    label: mic.label || `麦克风 ${index + 1}`,
    value: mic.deviceId
  }))
])

const selectedDevice = computed({
  get: () => props.device || DEFAULT_MIC_VALUE,
  set: value => emit('update:device', value === DEFAULT_MIC_VALUE ? '' : value)
})

const followLatest = computed({
  get: () => props.follow,
  set: value => emit('update:follow', value)
})

const latestAnalysis = computed(() => props.selected.analyses.at(-1) ?? null)
const olderAnalyses = computed(() => props.selected.analyses.slice(0, -1).reverse())
const hasNewSegments = computed(() => props.selected.segments.length > props.selected.analyzedCount)

watch(
  () => props.selected.id,
  () => {
    showHistory.value = false
    copied.value = false
  }
)

watch(
  () => [props.selected.segments.length, props.selected.interim?.text],
  async () => {
    if (props.follow) {
      await nextTick()
      transcriptPanel.value?.scrollTo({ top: transcriptPanel.value.scrollHeight, behavior: 'smooth' })
    }
  }
)

watch(
  [() => props.streaming, () => props.selected.analyses.length],
  async () => {
    if (props.follow) {
      await nextTick()
      analysisPanel.value?.scrollTo({ top: analysisPanel.value.scrollHeight, behavior: 'smooth' })
    }
  }
)

async function copySummary() {
  if (!latestAnalysis.value || !navigator.clipboard) return
  await navigator.clipboard.writeText(latestAnalysis.value.text)
  copied.value = true
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copied.value = false
  }, 2000)
}

function downloadMarkdown() {
  if (!latestAnalysis.value) return
  const markdown = `# ${props.selected.title}\n\n> 生成时间：${formatDate(latestAnalysis.value.created)}\n\n${latestAnalysis.value.text}\n`
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${props.selected.title}.md`
  link.click()
  URL.revokeObjectURL(url)
}

onBeforeUnmount(() => clearTimeout(copyTimer))
</script>

<template>
  <UAlert v-if="selected.error" color="warning" variant="soft" :description="selected.error" class="notice" />
  <div class="recording-bar">
    <div class="recording-clock">
      <span class="record-dot" :class="{ pulse: capturing }" />
      <strong>{{ formatDuration(active ? elapsed : selected.bytes / 32000) }}</strong>
      <span>{{ capturing ? '正在录音' : MEETING_STATUS_LABEL[selected.status] }}</span>
    </div>
    <div v-if="active" class="meter" aria-label="麦克风音量">
      <span :style="{ width: `${volume * 100}%` }" />
    </div>
    <span v-if="pending" class="pending">{{ pendingSeconds.toFixed(1) }} 秒待上传</span>
    <div class="recording-actions">
      <template v-if="['ready', 'paused', 'interrupted'].includes(selected.status)">
        <USelect
          v-model="selectedDevice"
          :items="deviceOptions"
          icon="i-lucide-mic"
          aria-label="选择麦克风"
          class="mic-select"
        />
        <UButton color="neutral" variant="ghost" :disabled="busy" @click="emit('loadMicrophones')">选择设备</UButton>
        <UButton :loading="busy" :disabled="analyzing" @click="emit('record')">
          {{ selected.status === 'ready' ? '开始录音' : '继续录音' }}
        </UButton>
      </template>
      <UButton v-if="capturing" color="neutral" variant="outline" :loading="busy" @click="emit('pause')">暂停</UButton>
      <UButton v-if="pending && !capturing" color="warning" variant="outline" :loading="busy" @click="emit('retry')">
        重试保存
      </UButton>
      <UButton
        v-if="['recording', 'paused', 'interrupted'].includes(selected.status)"
        color="neutral"
        :loading="busy"
        @click="emit('finish')"
      >
        结束并保存
      </UButton>
    </div>
  </div>

  <div class="studio-grid">
    <section class="studio-panel">
      <header>
        <div>
          <span class="panel-icon">≋</span>
          <h2>实时转写</h2>
          <UBadge color="neutral" variant="soft">{{ selected.segments.length }} 段</UBadge>
        </div>
        <span class="small muted">{{ capturing ? '实时分句识别中' : '按时间顺序记录' }}</span>
      </header>
      <div ref="transcriptPanel" class="panel-body transcript">
        <div v-if="!selected.segments.length && !selected.interim" class="empty-state">
          <span class="empty-icon">≋</span>
          <h3>{{ capturing ? '正在聆听你的会议…' : '对话，从这里留下来' }}</h3>
          <p>
            {{
              config.asr
                ? '开始录音后，确认的转写将出现在这里。'
                : '在个人设置中填写自己的百炼密钥，即可使用实时转写。'
            }}
          </p>
        </div>
        <article v-for="segment in selected.segments" :key="segment.id" class="segment">
          <div>
            <time>{{ formatDuration(segment.time) }}</time>
          </div>
          <p>{{ segment.text }}</p>
        </article>
        <article v-if="selected.interim" class="segment streaming" aria-live="polite">
          <div>
            <time>{{ formatDuration(selected.interim.time) }}</time>
            <UBadge color="primary" variant="soft">正在识别</UBadge>
          </div>
          <p>{{ selected.interim.text }}</p>
        </article>
      </div>
      <footer>
        <span class="small muted">{{ capturing ? '确认转写自动保存' : '录音与转写保存在服务器' }}</span>
        <UCheckbox v-model="followLatest" label="跟随最新" />
      </footer>
    </section>

    <section class="studio-panel analysis">
      <header>
        <div>
          <span class="panel-icon">✧</span>
          <h2>AI 会议洞察</h2>
          <UBadge v-if="analyzing" color="primary" variant="soft">
            {{ analyzingMode === 'incremental' ? '增量更新中' : '生成终版中' }}
          </UBadge>
          <UBadge v-else-if="latestAnalysis" :color="latestAnalysis.final ? 'primary' : 'neutral'" variant="soft">
            {{ latestAnalysis.final ? '全文纪要' : '实时增量' }}
          </UBadge>
        </div>
        <USwitch
          :model-value="selected.autoAnalyze"
          :disabled="!config.ai || busy"
          label="自动总结"
          size="sm"
          @update:model-value="emit('toggleAutoAnalyze', $event)"
        />
      </header>

      <div ref="analysisPanel" class="panel-body">
        <div v-if="!latestAnalysis && !analyzing" class="empty-state">
          <span class="empty-icon">✧</span>
          <h3>把讨论，变成清晰的下一步</h3>
          <p>
            {{
              config.ai
                ? '开启「自动总结」后将在录音中自动增量更新，结束时生成终版纪要；也可随时手动总结。'
                : '在个人设置中配置 DeepSeek 后，即可启用实时增量总结与终版纪要。'
            }}
          </p>
        </div>

        <article v-if="analyzing" class="analysis-primary streaming">
          <div class="analysis-meta">
            <span>✧ {{ analyzingMode === 'incremental' ? '正在结合新增转写更新纪要…' : '正在整理整场会议纪要…' }}</span>
          </div>
          <MarkdownView v-if="streaming" :content="streaming" />
          <p v-else class="muted">等待模型输出…</p>
        </article>

        <article v-else-if="latestAnalysis" class="analysis-primary">
          <div class="analysis-meta">
            <span>
              {{ latestAnalysis.final ? '整场全文纪要' : '会中实时纪要' }}
              <template v-if="latestAnalysis.coveredCount"> · 已覆盖 {{ latestAnalysis.coveredCount }} 段</template>
            </span>
            <time>{{ formatDate(latestAnalysis.created) }}</time>
          </div>
          <MarkdownView :content="latestAnalysis.text" />
        </article>

        <div v-if="!analyzing && olderAnalyses.length" class="history-snapshots">
          <button type="button" class="snapshot-toggle" @click="showHistory = !showHistory">
            <span>{{ showHistory ? '收起历史快照' : `查看历史快照（${olderAnalyses.length}）` }}</span>
            <UIcon :name="showHistory ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
          </button>
          <div v-if="showHistory" class="snapshot-list">
            <article v-for="item in olderAnalyses" :key="item.id" class="analysis-entry snapshot-item">
              <div class="analysis-meta">
                <UBadge :color="item.final ? 'primary' : 'neutral'" variant="subtle" size="xs">
                  {{ item.final ? '全文纪要' : '实时增量' }}
                </UBadge>
                <time>{{ formatDate(item.created) }}</time>
              </div>
              <MarkdownView :content="item.text" />
            </article>
          </div>
        </div>
      </div>

      <footer>
        <div v-if="latestAnalysis && !analyzing" class="analysis-tools">
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
            @click="copySummary"
          >
            {{ copied ? '已复制' : '复制纪要' }}
          </UButton>
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-download" @click="downloadMarkdown">
            导出 .md
          </UButton>
        </div>
        <span v-else class="small muted">
          {{
            config.ai
              ? selected.autoAnalyze
                ? '录音中自动增量更新 · 结束自动生成终版'
                : '基于确认转写 · 请核对关键信息'
              : '请在个人设置中配置 DeepSeek'
          }}
        </span>

        <div class="analysis-actions">
          <UButton
            v-if="latestAnalysis && hasNewSegments"
            size="sm"
            variant="soft"
            :loading="analyzing && analyzingMode === 'incremental'"
            :disabled="!config.ai || analyzing || busy"
            @click="emit('analyze', false)"
          >
            增量更新
          </UButton>
          <UButton
            size="sm"
            :variant="latestAnalysis && hasNewSegments ? 'ghost' : 'soft'"
            :color="latestAnalysis && hasNewSegments ? 'neutral' : 'primary'"
            :loading="analyzing && analyzingMode === 'full'"
            :disabled="!config.ai || !selected.segments.length || analyzing || busy"
            @click="emit('analyze', true)"
          >
            {{ !latestAnalysis ? '立即总结' : hasNewSegments ? '全文重整' : '重新总结全文' }}
          </UButton>
        </div>
      </footer>
    </section>
  </div>

  <div v-if="selected.bytes && !active" class="playback">
    <span>会议录音</span>
    <audio controls preload="none" :src="`/api/meetings/${selected.id}/audio`" />
    <UButton :href="`/api/meetings/${selected.id}/audio`" :download="`${selected.title}.wav`" color="neutral" variant="outline">
      下载录音
    </UButton>
    <UButton :href="`/api/meetings/${selected.id}/export`" color="neutral" variant="ghost">导出会议</UButton>
  </div>
  <p class="footnote">录音期间请保持页面打开。云端转写与 AI 分析可能产生服务商费用。</p>
</template>
