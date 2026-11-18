import { openWorkspace } from '../utils/auth'
import { apiJson, defineApiHandler } from '../utils/http'

export default defineApiHandler(event => {
  const workspace = openWorkspace(event)
  return apiJson({ ready: true }, 200, workspace.cookie ? { 'Set-Cookie': workspace.cookie } : undefined)
})
