import { requireWorkspace } from '../../utils/auth'
import { defineApiHandler } from '../../utils/http'
import { listMeetings } from '../../utils/meeting-room'

export default defineApiHandler(event => {
  const user = requireWorkspace(event)
  return listMeetings(user.id)
})
