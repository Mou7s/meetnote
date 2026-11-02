import { test, expect } from 'bun:test'
import { generateAnalysis } from '../worker/analysis'
import type { Meeting } from '../shared/types'
import type { ProviderSettings } from '../worker/settings'

test('manual summary includes all confirmed segments even after a previous analysis', async () => {
  const original = globalThis.fetch
  let request: any
  globalThis.fetch = (async (_url, init) => {
    request = JSON.parse(String(init?.body))
    return new Response('data: {"choices":[{"delta":{"content":"总结"}}]}\n\ndata: [DONE]\n\n')
  }) as typeof fetch
  try {
    const meeting = { title: '会议', analyzedCount: 1, segments: [{ time: 0, text: '先前内容' }, { time: 30, text: '新增内容' }], analyses: [{ text: '旧分析内容' }] } as Meeting
    const result = await generateAnalysis({ DEEPSEEK_API_KEY: 'test', DEEPSEEK_MODEL: 'test' } as ProviderSettings, meeting, false, async () => {}, new AbortController().signal)
    expect(result).toBe('总结')
    expect(request.messages[1].content).toContain('先前内容')
    expect(request.messages[1].content).toContain('新增内容')
    expect(request.messages[1].content).not.toContain('旧分析内容')
  } finally { globalThis.fetch = original }
})
