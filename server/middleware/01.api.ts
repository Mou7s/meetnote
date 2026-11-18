import { getHeader, getRequestURL } from 'h3'
import { apiErrorResponse } from '../utils/http'

export default defineEventHandler(event => {
  const url = getRequestURL(event)
  if (!url.pathname.startsWith('/api/')) return

  if (!['GET', 'HEAD'].includes(event.method) && getHeader(event, 'origin') !== url.origin) {
    return apiErrorResponse(403, '请求来源不受信任')
  }

  const sub = url.pathname.slice(5)
  if (sub.startsWith('auth/') || sub.startsWith('setup') || sub === 'users') {
    return apiErrorResponse(404, '无需账号，请直接打开工作台')
  }
})
