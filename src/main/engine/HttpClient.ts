import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import type { Readable } from 'node:stream'
import type { Agent } from 'node:http'
import { DEFAULT_USER_AGENT } from '@shared/constants'
import type { ProxyConfig } from '@shared/types'

export interface HttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  /** 连接建立后的静默超时（毫秒） */
  timeout?: number
  signal?: AbortSignal
  /** 忽略 TLS 证书校验错误 */
  insecureTLS?: boolean
  maxRedirects?: number
  proxy?: ProxyConfig
}

export interface HttpResponse {
  statusCode: number
  headers: http.IncomingHttpHeaders
  stream: Readable
  finalUrl: string
}

export class AbortError extends Error {
  code = 'ABORTED'
  constructor(message = '请求已中止') {
    super(message)
    this.name = 'AbortError'
  }
}

/** HTTP CONNECT 隧道代理 Agent，用于 https 目标穿透 */
class TunnelAgent extends https.Agent {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  private proxy: ProxyConfig
  private insecure: boolean

  constructor(proxy: ProxyConfig, insecure: boolean) {
    super({ keepAlive: true, maxSockets: 128, maxFreeSockets: 16 })
    this.proxy = proxy
    this.insecure = insecure
  }

  createConnection(options: any, callback: any): any {
    const host = String(options?.host ?? '')
    const port = Number(options?.port ?? 443)
    const auth =
      this.proxy.username && this.proxy.password
        ? Buffer.from(`${this.proxy.username}:${this.proxy.password}`).toString('base64')
        : undefined

    const req = http.request({
      host: this.proxy.host,
      port: this.proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: {
        Host: `${host}:${port}`,
        ...(auth ? { 'Proxy-Authorization': `Basic ${auth}` } : {})
      }
    })

    req.once('connect', (res, socket: net.Socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        callback(new Error(`代理隧道握手失败，状态码 ${res.statusCode}`))
        return
      }
      // 隧道本身是明文管道，必须在其上再完成一次 TLS 握手才能发送 https 请求
      const secure = tls.connect({
        socket,
        servername: host,
        rejectUnauthorized: !this.insecure
      })
      secure.once('secureConnect', () => callback(null, secure))
      secure.once('error', (err) => callback(err instanceof Error ? err : new Error(String(err))))
    })
    req.once('error', (err) => callback(err instanceof Error ? err : new Error(String(err))))
    req.end()
    return undefined
  }
}

let cachedAgent: Agent | null = null
let cachedKey = ''

function resolveAgent(target: URL, opts: HttpRequestOptions): Agent | undefined {
  const p = opts.proxy
  if (!p || !p.enabled || !p.host) return undefined

  const key = [
    p.type,
    p.host,
    p.port,
    p.username ?? '',
    p.password ?? '',
    target.protocol,
    opts.insecureTLS ? 'insecure' : 'strict'
  ].join('|')

  if (key !== cachedKey || !cachedAgent) {
    cachedKey = key
    cachedAgent =
      target.protocol === 'https:'
        ? new TunnelAgent(p, opts.insecureTLS === true)
        : new http.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 16 })
  }
  return cachedAgent
}

/**
 * 发起一次 HTTP(S) 请求，自动跟随重定向。
 * 返回的 stream 交给调用方按需消费（分片下载则按边界读取）。
 */
export async function httpRequest(urlStr: string, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
  let target = new URL(urlStr)
  const headers: Record<string, string> = {
    'User-Agent': opts.headers?.['User-Agent'] ?? DEFAULT_USER_AGENT,
    Accept: '*/*',
    // 拒绝压缩，确保字节偏移与 Range 计算严格一致
    'Accept-Encoding': 'identity',
    Connection: 'keep-alive',
    ...opts.headers
  }

  let redirects = 0
  const maxRedirects = opts.maxRedirects ?? 8

  for (;;) {
    const isSecure = target.protocol === 'https:'
    const agent = resolveAgent(target, opts)
    const plainProxy = !isSecure && !!agent

    const requestOptions: https.RequestOptions = {
      protocol: target.protocol,
      host: target.hostname,
      port: target.port ? Number(target.port) : isSecure ? 443 : 80,
      method: opts.method ?? 'GET',
      path: `${target.pathname}${target.search}`,
      headers: { ...headers, Host: target.host },
      timeout: opts.timeout,
      agent,
      rejectUnauthorized: opts.insecureTLS ? false : true
    }

    // 明文 HTTP 正向代理：目标地址交给代理，path 使用完整 URL
    if (plainProxy && opts.proxy) {
      const p = opts.proxy
      requestOptions.host = p.host
      requestOptions.port = p.port
      requestOptions.path = target.toString()
      if (p.username && p.password) {
        requestOptions.headers = {
          ...requestOptions.headers,
          'Proxy-Authorization': `Basic ${Buffer.from(`${p.username}:${p.password}`).toString('base64')}`
        }
      }
    }

    const response = await execOnce(isSecure ? https.request : http.request, requestOptions, opts)
    const location = response.headers.location

    if (response.statusCode >= 300 && response.statusCode < 400 && location && redirects < maxRedirects) {
      redirects += 1
      response.stream.resume()
      target = new URL(location, target)
      continue
    }

    return { ...response, finalUrl: target.toString() }
  }
}

function execOnce(
  requestFn: typeof http.request,
  requestOptions: https.RequestOptions,
  opts: HttpRequestOptions
): Promise<Omit<HttpResponse, 'finalUrl'>> {
  return new Promise((resolve, reject) => {
    let settled = false

    const cleanup = (): void => {
      opts.signal?.removeEventListener('abort', onAbort)
    }

    const onAbort = (): void => {
      if (settled) return
      settled = true
      req.destroy(new AbortError())
    }

    const req = requestFn(requestOptions, (res) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, stream: res })
    })

    if (opts.signal) {
      if (opts.signal.aborted) {
        req.destroy()
        reject(new AbortError())
        return
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    req.on('timeout', () => {
      if (settled) return
      settled = true
      cleanup()
      req.destroy(new Error('连接超时'))
    })

    req.on('error', (err) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    })

    req.end()
  })
}
