<script setup lang="ts">
import type { UserConfig } from '../../shared/types'

defineProps<{
  config: UserConfig
  busy: boolean
  analyzing: boolean
}>()

const emit = defineEmits<{
  start: []
}>()
</script>

<template>
  <section class="launch-wrap">
    <UCard class="launch-card">
      <div class="launch-icon"><UIcon name="i-lucide-mic" /></div>
      <UBadge color="neutral" variant="soft">{{ config.asr ? '实时转写已就绪' : '录音可用 · 转写待配置' }}</UBadge>
      <h2>准备好就开始</h2>
      <p>点击后立即开始录音，系统会按开始时间自动命名并保存这段记录。</p>
      <UButton size="xl" icon="i-lucide-mic" :loading="busy" :disabled="analyzing" @click="emit('start')">
        开始录音
      </UButton>
      <div class="launch-services">
        <span>
          <UIcon :name="config.asr ? 'i-lucide-circle-check' : 'i-lucide-circle-dashed'" />
          百炼转写 {{ config.asr ? '已连接' : '未配置' }}
        </span>
        <span>
          <UIcon :name="config.ai ? 'i-lucide-circle-check' : 'i-lucide-circle-dashed'" />
          DeepSeek 分析 {{ config.ai ? '已连接' : '未配置' }}
        </span>
      </div>
    </UCard>
    <p class="launch-hint">
      <UIcon name="i-lucide-shield-check" />
      录音保存在你的独立工作空间中。云端转写会将音频发送至你配置的百炼服务。
    </p>
  </section>
</template>
