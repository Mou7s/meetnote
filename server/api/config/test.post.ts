import { z } from 'zod'
import { testAnalysisConnection } from '../../services/analysis'
import { testAsrConnection } from '../../services/asr'
import { rateLimit, requireWorkspace } from '../../utils/auth'
import { defineApiHandler, readJsonBody } from '../../utils/http'
import {
  ALIYUN_MODELS,
  defaultSettings,
  getSettings,
  isSupportedAliyunHost,
  normalizeAliyunHost
} from '../../utils/settings'

const testSchema = z.discriminatedUnion('service', [
  z.object({
    service: z.literal('asr'),
    aliyunKey: z.string().trim().max(512).optional(),
    useSaved: z.boolean().default(false),
    aliyunHost: z
      .string()
      .trim()
      .transform(normalizeAliyunHost)
      .refine(isSupportedAliyunHost, '百炼地址无效'),
    aliyunModel: z.enum(ALIYUN_MODELS)
  }),
  z.object({
    service: z.literal('ai'),
    deepseekKey: z.string().trim().max(512).optional(),
    useSaved: z.boolean().default(false),
    deepseekModel: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9._:/-]+$/)
  })
])

export default defineApiHandler(async event => {
  const user = requireWorkspace(event)
  rateLimit(`config-test:${user.id}`, 30)
  const input = testSchema.parse(await readJsonBody(event))

  if (input.service === 'asr') {
    const apiKey = input.aliyunKey || (input.useSaved ? (await getSettings(user.id)).ALIYUN_API_KEY : undefined)
    if (!apiKey) return { ok: false, message: '请先填写百炼 API Key' }
    return testAsrConnection({
      ...defaultSettings(),
      ALIYUN_API_KEY: apiKey,
      ALIYUN_HOST: input.aliyunHost,
      ALIYUN_MODEL: input.aliyunModel
    })
  }

  const apiKey = input.deepseekKey || (input.useSaved ? (await getSettings(user.id)).DEEPSEEK_API_KEY : undefined)
  if (!apiKey) return { ok: false, message: '请先填写 DeepSeek API Key' }
  return testAnalysisConnection({
    ...defaultSettings(),
    DEEPSEEK_API_KEY: apiKey,
    DEEPSEEK_MODEL: input.deepseekModel
  })
})
