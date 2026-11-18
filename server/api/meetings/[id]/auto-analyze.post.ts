import { getRouterParam } from 'h3'
import { z } from 'zod'
import { requireWorkspace } from '../../../utils/auth'
import { defineApiHandler, readJsonBody } from '../../../utils/http'
import { setAutoAnalyze } from '../../../utils/meeting-room'

export default defineApiHandler(async event => {
  const user = requireWorkspace(event)
  const id = z.uuid().parse(getRouterParam(event, 'id'))
  const { enabled } = z.object({ enabled: z.boolean() }).parse(await readJsonBody(event))
  return setAutoAnalyze(user.id, id, enabled)
})
