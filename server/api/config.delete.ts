import { requireWorkspace } from '../utils/auth'
import { defineApiHandler } from '../utils/http'
import { deleteSettings, getSettings, publicSettings } from '../utils/settings'

export default defineApiHandler(async event => {
  const user = requireWorkspace(event)
  deleteSettings(user.id)
  return publicSettings(await getSettings(user.id))
})
