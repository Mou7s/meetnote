<script setup lang="ts">
import type { MeetingSummary } from '../../shared/types'

defineProps<{
  meetings: MeetingSummary[]
  busy: boolean
}>()

const emit = defineEmits<{
  startNew: []
  open: [id: string]
}>()
</script>

<template>
  <div class="page-heading">
    <div>
      <span class="eyebrow">YOUR CONVERSATIONS</span>
      <h1>会议记录</h1>
      <p class="muted">回到讨论现场，找到每一个决定。</p>
    </div>
    <UButton icon="i-lucide-mic" :loading="busy" @click="emit('startNew')">开始录音</UButton>
  </div>

  <div v-if="!meetings.length" class="empty-history">还没有录音记录。点击“开始录音”即可开始。</div>
  <div v-else class="history-list">
    <button v-for="meeting in meetings" :key="meeting.id" class="history-row" @click="emit('open', meeting.id)">
      <div class="history-icon">◫</div>
      <div class="history-title">
        <strong>{{ meeting.title }}</strong>
        <small>
          {{ formatDate(meeting.created) }} · {{ meeting.segmentCount }} 段转写 · {{ meeting.analysisCount }} 次分析
        </small>
      </div>
      <span>{{ formatDuration(meeting.bytes / 32000) }}</span>
      <UBadge color="neutral" variant="soft">{{ MEETING_STATUS_LABEL[meeting.status] }}</UBadge>
      <span>↗</span>
    </button>
  </div>
</template>
