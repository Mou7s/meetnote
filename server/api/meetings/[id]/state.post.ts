import { getRouterParam } from 'h3'
import { z } from 'zod'
import { requireWorkspace } from '../../../utils/auth'
import { defineApiHandler, readJsonBody } from '../../../utils/http'
import { updateMeetingState } from '../../../utils/meeting-room'
import { getSettings } from '../../../utils/settings'

export default defineApiHandler(async event => {
  const user = requireWorkspace(event)
  const id = z.uuid().parse(getRouterParam(event, 'id'))
  const { action } = z.object({ action: z.enum(['start', 'pause', 'resume', 'stop']) }).parse(await readJsonBody(event))
  const provider = ['start', 'resume'].includes(action) ? await getSettings(user.id) : undefined
  return updateMeetingState(user.id, id, action, provider)
})
