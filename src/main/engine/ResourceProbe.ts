import { httpRequest } from './HttpClient'
import type { HttpRequestOptions } from './HttpClient'

export interface ProbeInfo {
  fileName: string
  totalSize: number
  supportsRange: boolean
  contentType?: string
  finalUrl: string
}

/**
 * 探测目标资源。
 * 使用 Range: bytes=0-0 的单字节试探：
 *  - 返回 206 表示支持分片，从 Content-Range 取精确长度
 *  - 返回 200 表示不支持分片，退化为单连接下载
 */
export async function probeResource(
  url: string,
  opts: Omit<HttpRequestOptions, 'headers' | 'method'> = {}
): Promise<ProbeInfo> {
  const res = await httpRequest(url, {
    ...opts,
    method: 'GET',
    headers: { Range: 'bytes=0-0' }
  })

  let supportsRange = false
  let totalSize = 0

  if (res.statusCode === 206) {
    supportsRange = true
    const cr = res.headers['content-range']
    const tail = cr ? cr.slice(cr.lastIndexOf('/') + 1).trim() : ''
    if (tail.length > 0 && tail !== '*' && isNumeric(tail)) {
      totalSize = Number(tail)
    }
  } else if (res.statusCode === 200) {
    supportsRange = false
    const len = res.headers['content-length']
    if (len && isNumeric(String(len))) totalSize = Number(String(len))
  } else if (res.statusCode >= 400) {
    res.stream.destroy()
    throw new Error('HTTP ' + res.statusCode)
  }

  // 丢弃试探响应体，释放连接
  res.stream.destroy()

  const contentType = res.headers['content-type']
  const fileName = sanitizeFileName(
    extractFileNameFromDisposition(res.headers['content-disposition']) ||
      extractFileNameFromUrl(res.finalUrl, contentType)
  )

  return { fileName, totalSize, supportsRange, contentType, finalUrl: res.finalUrl }
}

function isNumeric(s: string): boolean {
  if (s.length === 0) return false
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i)
    if (code < 48 || code > 57) return false
  }
  return true
}

/** 从 Content-Disposition 提取文件名，优先 RFC 5987 的 filename* 编码形式 */
export function extractFileNameFromDisposition(header?: string): string {
  if (!header) return ''
  let plain = ''
  for (const rawPart of header.split(';')) {
    const part = rawPart.trim()
    const lower = part.toLowerCase()
    if (lower.startsWith('filename*=')) {
      const value = part.slice('filename*='.length).trim()
      const quote = value.indexOf("''")
      if (quote >= 0) {
        return stripQuotes(safeDecode(value.slice(quote + 2), value.slice(0, quote)))
      }
      return stripQuotes(safeDecode(value, 'utf-8'))
    }
    if (lower.startsWith('filename=')) {
      plain = stripQuotes(part.slice('filename='.length).trim())
    }
  }
  return plain
}

/**
 * 按 Content-Disposition 声明的字符集解码文件名。
 * UTF-8 直接走 decodeURIComponent；GBK 等非 UTF-8 需先还原字节再按字符集解码，
 * 否则国内站点常见的 GBK 文件名会变成乱码。
 */
function safeDecode(value: string, charset: string): string {
  if (value.indexOf('%') < 0) return value

  const normalized = charset.toLowerCase().split('-').join('')
  const isUtf8 = charset === '' || normalized.indexOf('utf') === 0

  if (isUtf8) {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }

  try {
    const bytes: number[] = []
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === '%' && i + 2 < value.length) {
        const byte = parseInt(value.slice(i + 1, i + 3), 16)
        if (Number.isFinite(byte)) {
          bytes.push(byte)
          i += 2
          continue
        }
      }
      bytes.push(value.charCodeAt(i) & 0xff)
    }
    return new TextDecoder(charset).decode(new Uint8Array(bytes))
  } catch {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
}

function stripQuotes(s: string): string {
  const quoteMarks = ['"', "'"]
  let start = 0
  let end = s.length
  while (start < end && quoteMarks.indexOf(s[start]) >= 0) start += 1
  while (end > start && quoteMarks.indexOf(s[end - 1]) >= 0) end -= 1
  return s.slice(start, end)
}

/** 从 URL 路径推断文件名 */
export function extractFileNameFromUrl(finalUrl: string, contentType?: string): string {
  let pathname = finalUrl
  const hashIdx = pathname.indexOf('#')
  if (hashIdx >= 0) pathname = pathname.slice(0, hashIdx)
  const qIdx = pathname.indexOf('?')
  if (qIdx >= 0) pathname = pathname.slice(0, qIdx)
  const slashIdx = pathname.lastIndexOf('/')
  let name = slashIdx >= 0 ? pathname.slice(slashIdx + 1) : pathname
  try {
    name = decodeURIComponent(name)
  } catch {
    /* 非法百分号编码时保留原始串 */
  }
  if (name.length > 0) return name
  if (contentType && contentType.indexOf('octet-stream') >= 0) return 'download.bin'
  return 'download'
}

/** 清洗 Windows / POSIX 文件名中的非法字符与控制符 */
export function sanitizeFileName(raw: string): string {
  // 92 为反斜杠，其余依次为 / : * ? < > | "
  const illegalCodes = [92, 47, 58, 42, 63, 60, 62, 124, 34]
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const illegal = code < 32 || illegalCodes.indexOf(code) >= 0
    out += illegal ? '_' : raw[i]
  }
  out = out.trim()
  while (out.endsWith('.')) out = out.slice(0, -1)
  return out.length > 0 ? out.slice(0, 180) : 'download'
}
