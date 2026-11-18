import { getHeader, getRouterParam } from 'h3'
import { z } from 'zod'
import { requireWorkspace } from '../../../utils/auth'
import { defineApiHandler } from '../../../utils/http'
import { streamMeetingAudio } from '../../../utils/meeting-room'

export default defineApiHandler(event => {
  const user = requireWorkspace(event)
  const id = z.uuid().parse(getRouterParam(event, 'id'))
  return streamMeetingAudio(user.id, id, getHeader(event, 'range') || null)
})
