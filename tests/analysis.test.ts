import { test, expect } from 'bun:test'
import { generateAnalysis, testAnalysisConnection } from '../server/services/analysis'
import type { Meeting } from '../shared/types'
import { normalizeAliyunHost, type ProviderSettings } from '../server/utils/settings'

test('full summary includes all confirmed segments even after a previous analysis', async () => {
  const original = globalThis.fetch
  let request: any
  globalThis.fetch = (async (_url, init) => {
    request = JSON.parse(String(init?.body))
    return new Response('data: {"choices":[{"delta":{"content":"总结"}}]}\n\ndata: [DONE]\n\n')
  }) as typeof fetch
  try {
    const meeting = {
      title: '会议',
      analyzedCount: 1,
      segments: [
        { id: '1', time: 0, text: '先前内容' },
        { id: '2', time: 30, text: '新增内容' }
      ],
      analyses: [{ id: 'a1', created: '2026-11-18T00:00:00Z', text: '旧分析内容', final: false }]
    } as Meeting
    const result = await generateAnalysis(
      { DEEPSEEK_API_KEY: 'test', DEEPSEEK_MODEL: 'test' } as ProviderSettings,
      meeting,
      true,
      async () => {},
      new AbortController().signal
    )
    expect(result).toBe('总结')
    expect(request.messages[1].content).toContain('先前内容')
    expect(request.messages[1].content).toContain('新增内容')
    expect(request.messages[1].content).not.toContain('旧分析内容')
  } finally {
    globalThis.fetch = original
  }
})

test('incremental summary sends existing summary and only newly added segments', async () => {
  const original = globalThis.fetch
  let request: any
  globalThis.fetch = (async (_url, init) => {
    request = JSON.parse(String(init?.body))
    return new Response('data: {"choices":[{"delta":{"content":"增量更新"}}]}\n\ndata: [DONE]\n\n')
  }) as typeof fetch
  try {
    const meeting = {
      title: '会议',
      analyzedCount: 1,
      segments: [
        { id: '1', time: 0, text: '先前内容' },
        { id: '2', time: 65, text: '新增内容' }
      ],
      analyses: [{ id: 'a1', created: '2026-11-18T00:00:00Z', text: '旧分析内容', final: false }]
    } as Meeting
    const result = await generateAnalysis(
      { DEEPSEEK_API_KEY: 'test', DEEPSEEK_MODEL: 'test' } as ProviderSettings,
      meeting,
      false,
      async () => {},
      new AbortController().signal
    )
    expect(result).toBe('增量更新')
    expect(request.messages[1].content).toContain('旧分析内容')
    expect(request.messages[1].content).toContain('[01:05] 新增内容')
    expect(request.messages[1].content).not.toContain('先前内容')
  } finally {
    globalThis.fetch = original
  }
})

test('testAnalysisConnection checks key and model without throwing', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))) as typeof fetch
    const ok = await testAnalysisConnection({
      DEEPSEEK_API_KEY: 'test',
      DEEPSEEK_MODEL: 'deepseek-flash',
      ALIYUN_HOST: 'dashscope.aliyuncs.com',
      ALIYUN_MODEL: 'qwen-audio-3.1-asr-flash-streaming'
    })
    expect(ok.ok).toBe(true)

    globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch
    const badKey = await testAnalysisConnection({
      DEEPSEEK_API_KEY: 'bad',
      DEEPSEEK_MODEL: 'deepseek-flash',
      ALIYUN_HOST: 'dashscope.aliyuncs.com',
      ALIYUN_MODEL: 'qwen-audio-3.1-asr-flash-streaming'
    })
    expect(badKey.ok).toBe(false)
    expect(badKey.message).toContain('无效')
  } finally {
    globalThis.fetch = original
  }
})

test('normalizeAliyunHost strips schemes and paths', () => {
  expect(normalizeAliyunHost('https://dashscope.aliyuncs.com/api-ws/v1/inference')).toBe('dashscope.aliyuncs.com')
  expect(normalizeAliyunHost('wss://ws-demo.cn-beijing.maas.aliyuncs.com/')).toBe('ws-demo.cn-beijing.maas.aliyuncs.com')
})
