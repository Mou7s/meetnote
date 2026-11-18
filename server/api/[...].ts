import { apiErrorResponse, defineApiHandler } from '../utils/http'

export default defineApiHandler(() => apiErrorResponse(404, '接口不存在'))
