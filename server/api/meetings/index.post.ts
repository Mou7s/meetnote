import { z } from 'zod'
import { rateLimit, requireWorkspace } from '../../utils/auth'
import { defineApiHandler, readJsonBody } from '../../utils/http'
import { createMeeting } from '../../utils/meeting-room'

const createMeetingSchema = z.object({
  title: z.string().trim().min(1).max(160),
  context: z.string().max(400).default(''),
  terms: z.string().max(4000).default(''),
  autoAnalyze: z.boolean().default(false)
})

export default defineApiHandler(async event => {
  const user = requireWorkspace(event)
  rateLimit(`create-meeting:${user.id}`, 60)
  const input = createMeetingSchema.parse(await readJsonBody(event))
  return createMeeting(user.id, input)
})
