import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { HttpError } from './http'

export type ProviderSettings = {
  ALIYUN_API_KEY?: string; DEEPSEEK_API_KEY?: string;
  ALIYUN_HOST: string; ALIYUN_MODEL: string; DEEPSEEK_MODEL: string
}
export const defaultSettings = (): ProviderSettings => ({
  ALIYUN_HOST: 'dashscope.aliyuncs.com', ALIYUN_MODEL: 'qwen-audio-3.1-asr-flash-streaming', DEEPSEEK_MODEL: 'deepseek-flash'
})
export const isSupportedAliyunHost = (host: string) =>
  host === 'dashscope.aliyuncs.com' || host === 'dashscope-intl.aliyuncs.com' ||
  /^ws-[a-z0-9]+(?:-[a-z0-9]+)*\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(host)
export const settingsInput = z.object({
  aliyunKey: z.string().trim().max(512).optional(), deepseekKey: z.string().trim().max(512).optional(),
  clearAliyun: z.boolean().default(false), clearDeepseek: z.boolean().default(false),
  aliyunHost: z.string().trim().refine(isSupportedAliyunHost, '百炼地址无效'),
  aliyunModel: z.enum(['qwen-audio-3.1-asr-flash-streaming', 'fun-asr-realtime', 'paraformer-realtime-v2']),
  deepseekModel: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._:/-]+$/)
})
async function key(env: Env) {
  const secret = env.USER_KEYS_ENCRYPTION_KEY
  if (!secret || !/^[a-fA-F0-9]{64}$/.test(secret)) throw new HttpError(503, '个人密钥存储尚未配置，请联系站点维护者')
  return crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g)!, byte => parseInt(byte, 16)), 'AES-GCM', false, ['encrypt', 'decrypt'])
}
export async function getSettings(env: Env, userId: string): Promise<ProviderSettings> {
  const row = await env.DB.prepare('SELECT ciphertext FROM user_settings WHERE user_id=?').bind(userId).first<{ ciphertext: string }>()
  if (!row) return defaultSettings()
  const [version, iv, encrypted] = row.ciphertext.split(':')
  if (version !== 'v1' || !iv || !encrypted) throw new HttpError(503, '个人密钥数据无法读取')
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64'), additionalData: new TextEncoder().encode(userId) }, await key(env), Buffer.from(encrypted, 'base64'))
    return { ...defaultSettings(), ...JSON.parse(new TextDecoder().decode(plain)) }
  } catch { throw new HttpError(503, '个人密钥数据无法解密，请联系站点维护者') }
}
export const publicSettings = (settings: ProviderSettings) => ({
  asr: !!settings.ALIYUN_API_KEY, ai: !!settings.DEEPSEEK_API_KEY,
  aliyunHost: settings.ALIYUN_HOST, aliyunModel: settings.ALIYUN_MODEL, deepseekModel: settings.DEEPSEEK_MODEL
})
export async function updateSettings(env: Env, userId: string, input: z.infer<typeof settingsInput>) {
  const previous = await getSettings(env, userId)
  const next: ProviderSettings = {
    ALIYUN_HOST: input.aliyunHost, ALIYUN_MODEL: input.aliyunModel, DEEPSEEK_MODEL: input.deepseekModel,
    ALIYUN_API_KEY: input.clearAliyun ? undefined : input.aliyunKey || previous.ALIYUN_API_KEY,
    DEEPSEEK_API_KEY: input.clearDeepseek ? undefined : input.deepseekKey || previous.DEEPSEEK_API_KEY
  }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(userId) }, await key(env), new TextEncoder().encode(JSON.stringify(next)))
  const envelope = `v1:${Buffer.from(iv).toString('base64')}:${Buffer.from(encrypted).toString('base64')}`
  await env.DB.prepare('INSERT INTO user_settings VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at').bind(userId, envelope, new Date().toISOString()).run()
  return publicSettings(next)
}
