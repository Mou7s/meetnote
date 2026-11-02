export class HttpError extends Error {
  constructor(public status: number, message: string) { super(`[${status}] ${message}`) }
}
export const json = (body: unknown, status = 200, headers?: HeadersInit) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } })
export async function readLimited(request: Request, limit = 150000) {
  if (Number(request.headers.get('Content-Length') || 0) > limit) throw new HttpError(413, '请求内容过大')
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    length += value.length
    if (length > limit) { await reader.cancel(); throw new HttpError(413, '请求内容过大') }
    chunks.push(value)
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
  return result
}
export async function body(request: Request) {
  try { return JSON.parse(new TextDecoder().decode(await readLimited(request))) }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, '无效 JSON 请求') }
}
