import { resolve } from 'node:path'

export function getEncryptionKey() {
  const config = useRuntimeConfig()
  return process.env.USER_KEYS_ENCRYPTION_KEY || config.userKeysEncryptionKey || ''
}

export function getDataDir() {
  const config = useRuntimeConfig()
  const raw = process.env.MEETNOTE_DATA_DIR || config.dataDir || '.data/store'
  return resolve(raw)
}
