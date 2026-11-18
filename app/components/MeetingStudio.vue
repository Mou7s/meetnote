<script setup lang="ts">
import type { Meeting, UserConfig } from '../../shared/types'

const props = defineProps<{
  selected: Meeting
  config: UserConfig
  busy: boolean
  analyzing: boolean
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
  mark: [segmentId: string]
  analyze: []
}>()

const transcriptPanel = ref<HTMLElement | null>(null)
const analysisPanel = ref<HTMLElement | null>(null)

const selectedDevice = computed({
  get: () => props.device,
  set: value => emit('update:device', value)
})

const followLatest = computed({
  get: () => props.follow,
  set: value => emit('update:follow', value)
})

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
        <select v-model="selectedDevice" aria-label="选择麦克风">
          <option value="">默认麦克风</option>
          <option v-for="(mic, index) in devices" :key="mic.deviceId" :value="mic.deviceId">
            {{ mic.label || `麦克风 ${index + 1}` }}
          </option>
        </select>
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
        :disabled="analyzing"
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
        <span class="small muted">点击 ☆ 标记重点</span>
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
        <article
          v-for="segment in selected.segments"
          :key="segment.id"
          class="segment"
          :class="{ marked: segment.marked }"
        >
          <div>
            <time>{{ formatDuration(segment.time) }}</time>
            <button
              :aria-label="segment.marked ? '取消重点' : '标记重点'"
              :aria-pressed="segment.marked"
              @click="emit('mark', segment.id)"
            >
              {{ segment.marked ? '★' : '☆' }}
            </button>
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
        </div>
      </header>
      <div ref="analysisPanel" class="panel-body">
        <div v-if="!selected.analyses.length && !analyzing" class="empty-state">
          <span class="empty-icon">✧</span>
          <h3>把讨论，变成清晰的下一步</h3>
          <p>提炼要点、整理决定、追踪待办。<br />点击“立即分析”，总结左侧全部已确认转写。</p>
        </div>
        <article v-for="analysis in selected.analyses" :key="analysis.id" class="analysis-entry">
          <div class="analysis-meta">
            <UBadge :color="analysis.final ? 'primary' : 'neutral'" variant="soft">
              {{ analysis.final ? '全文总结' : '历史分析' }}
            </UBadge>
            <time>{{ formatDate(analysis.created) }}</time>
          </div>
          <p>{{ analysis.text }}</p>
        </article>
        <article v-if="analyzing" class="analysis-entry streaming">
          <div class="analysis-meta">✧ 正在整理思路…</div>
          <p>{{ streaming || '等待分析内容…' }}</p>
        </article>
      </div>
      <footer>
        <span class="small muted">{{ config.ai ? '基于确认转写 · 请核对关键信息' : '请在个人设置中配置 DeepSeek' }}</span>
        <UButton
          size="sm"
          variant="soft"
          :loading="analyzing"
          :disabled="!config.ai || !selected.segments.length || busy"
          @click="emit('analyze')"
        >
          立即分析
        </UButton>
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
