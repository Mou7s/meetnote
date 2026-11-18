import { requireWorkspace } from '../utils/auth'
import { defineApiHandler } from '../utils/http'
import { getSettings, publicSettings } from '../utils/settings'

export default defineApiHandler(async event => {
  const user = requireWorkspace(event)
  return publicSettings(await getSettings(user.id))
})
