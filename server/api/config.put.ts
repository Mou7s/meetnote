import { rateLimit, requireWorkspace } from '../utils/auth'
import { defineApiHandler, readJsonBody } from '../utils/http'
import { settingsInput, updateSettings } from '../utils/settings'

export default defineApiHandler(async event => {
  const user = requireWorkspace(event)
  rateLimit(`settings:${user.id}`, 30)
  const input = settingsInput.parse(await readJsonBody(event))
  return updateSettings(user.id, input)
})
