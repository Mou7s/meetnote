import { getRouterParam } from 'h3'
import { z } from 'zod'
import { rateLimit, requireWorkspace } from '../../../utils/auth'
import { defineApiHandler, readJsonBody } from '../../../utils/http'
import { streamMeetingAnalysis } from '../../../utils/meeting-room'
import { getSettings } from '../../../utils/settings'

export default defineApiHandler(async event => {
  const user = requireWorkspace(event)
  const id = z.uuid().parse(getRouterParam(event, 'id'))
  rateLimit(`analyze:${user.id}`, 60, 60000)
  const { final } = z.object({ final: z.boolean().default(false) }).parse(await readJsonBody(event))
  return streamMeetingAnalysis(user.id, id, final, await getSettings(user.id))
})
