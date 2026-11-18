import { getHeader, getRouterParam } from 'h3'
import { z } from 'zod'
import { requireWorkspace } from '../../../utils/auth'
import { defineApiHandler, readLimitedBytes } from '../../../utils/http'
import { uploadAudioChunk } from '../../../utils/meeting-room'

export default defineApiHandler(async event => {
  const user = requireWorkspace(event)
  const id = z.uuid().parse(getRouterParam(event, 'id'))
  const sequence = z
    .string()
    .regex(/^\d{1,9}$/)
    .transform(Number)
    .parse(getHeader(event, 'x-audio-sequence'))
  const bytes = await readLimitedBytes(event, 128000)
  return uploadAudioChunk(user.id, id, sequence, bytes)
})
