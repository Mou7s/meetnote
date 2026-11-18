import { markInterruptedMeetingsOnStartup, shutdownMeetingRooms } from '../utils/meeting-room'

export default defineNitroPlugin(nitroApp => {
  markInterruptedMeetingsOnStartup()
  nitroApp.hooks.hook('close', () => {
    shutdownMeetingRooms()
  })
})
