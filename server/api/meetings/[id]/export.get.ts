import { getRouterParam } from 'h3'
import { z } from 'zod'
import { requireWorkspace } from '../../../utils/auth'
import { apiJson, defineApiHandler } from '../../../utils/http'
import { getMeetingDetail } from '../../../utils/meeting-room'

export default defineApiHandler(event => {
  const user = requireWorkspace(event)
  const id = z.uuid().parse(getRouterParam(event, 'id'))
  return apiJson(getMeetingDetail(user.id, id), 200, {
    'Content-Disposition': `attachment; filename="meetnote-${id}.json"`
  })
})
