import type { H3Event } from 'h3'
import { getHeader, readRawBody } from 'h3'
import { ZodError } from 'zod'

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

const API_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
}

export function apiJson(body: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(body, {
    status,
    headers: { ...API_HEADERS, ...headers }
  })
}

export function apiErrorResponse(status: number, message: string) {
  return apiJson({ statusMessage: message }, status)
}

export async function readLimitedBytes(event: H3Event, limit = 150000): Promise<Uint8Array> {
  const declared = Number(getHeader(event, 'content-length') || 0)
  if (declared > limit) throw new HttpError(413, '请求内容过大')
  const raw = await readRawBody(event, false)
  if (!raw) return new Uint8Array()
  if (raw.byteLength > limit) throw new HttpError(413, '请求内容过大')
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
}

export async function readJsonBody(event: H3Event, limit = 150000): Promise<unknown> {
  const bytes = await readLimitedBytes(event, limit)
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new HttpError(400, '无效 JSON 请求')
  }
}

export function defineApiHandler<T>(handler: (event: H3Event) => Promise<T> | T) {
  return defineEventHandler(async event => {
    try {
      const result = await handler(event)
      if (result instanceof Response) return result
      return apiJson(result)
    } catch (error) {
      if (error instanceof HttpError) return apiErrorResponse(error.status, error.message)
      if (error instanceof ZodError) return apiErrorResponse(400, '输入格式不正确，请检查填写内容')
      console.error(
        JSON.stringify({
          event: 'api_failure',
          path: event.path,
          error: error instanceof Error ? error.name : 'UnknownError'
        })
      )
      return apiErrorResponse(500, '服务暂时不可用，请重试或联系管理员')
    }
  })
}
