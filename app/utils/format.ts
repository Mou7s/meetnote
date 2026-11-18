import type { Meeting } from '../../shared/types'

export const MEETING_STATUS_LABEL: Record<Meeting['status'], string> = {
  ready: '待开始',
  recording: '录音中',
  paused: '已暂停',
  completed: '已结束',
  interrupted: '已中断'
}

export function formatDuration(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
}

export function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function extractErrorMessage(error: unknown) {
  const failure = error as { data?: { statusMessage?: string; message?: string }; message?: string }
  return failure.data?.statusMessage || failure.data?.message || failure.message || '操作失败，请重试'
}
