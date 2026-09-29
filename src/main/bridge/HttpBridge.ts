import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AppSettings, TaskSnapshot } from '@shared/types'

export interface BridgeHandlers {
  createTasks: (payload: {
    urls: string[]
    fileName?: string
    dirPath?: string
    referrer?: string
  }) => Promise<{ ok: boolean; ids?: string[]; error?: string }>
  createSingle: (payload: {
    url: string
    fileName?: string
    dirPath?: string
    referrer?: string
  }) => Promise<{ ok: boolean; id?: string; error?: string }>
  listTasks: () => TaskSnapshot[]
  getVersion: () => string
  notify: (payload: { title: string; body: string }) => void
}

/**
 * 本地通信桥接服务
 *
 * 浏览器扩展通过 http://127.0.0.1:<port> 调用本机 API 下发下载任务。
 *
 * 安全措施（三重，缺一不可）：
 *  1. 仅绑定 127.0.0.1，外部网络不可达；
 *  2. Origin 必须是 chrome-extension:// 或 moz-extension://，阻断恶意网页；
 *  3. 写操作需携带 token，token 只能由通过上述校验的扩展换取。
 * 缺少第 2 条时，任意网页都可向本机端口下发下载任务，属于典型的本地 CSRF 风险。
 */
export class HttpBridge {
  private server: http.Server | null = null
  private token = randomBytes(24).toString('hex')
  private actualPort = 0

  constructor(private readonly handlers: BridgeHandlers) {}

  get port(): number {
    return this.actualPort
  }

  get running(): boolean {
    return !!this.server?.listening
  }

  /** 启动服务，端口被占用时自动顺延 */
  async start(startPort: number): Promise<number> {
    if (this.server) return this.actualPort

    const maxAttempts = 12
    let lastError: Error | null = null

    for (let i = 0; i < maxAttempts; i += 1) {
      const port = startPort + i
      try {
        await this.listen(port)
        return this.actualPort
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
      }
    }
    throw lastError ?? new Error('无法绑定本地端口')
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.route(req, res)
      })
      server.on('error', reject)
      server.listen(port, '127.0.0.1', () => {
        // port=0 时由系统随机分配，必须读回真实端口
        const addr = server.address()
        this.actualPort = addr && typeof addr === 'object' ? addr.port : port
        this.server = server
        resolve()
      })
    })
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
      this.actualPort = 0
    }
  }

  /** 复用现有端口重启（配置变更后） */
  async restart(startPort: number): Promise<number> {
    this.stop()
    return this.start(startPort)
  }

  // ---------- 内部实现 ----------

  private isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) return false
    return origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown, origin?: string): void {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      // 只对扩展来源回显，不给通配符以免被普通网页利用
      ...(origin && this.isAllowedOrigin(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Access-Control-Allow-Headers': 'Content-Type, X-FluxGet-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Cache-Control': 'no-store'
    })
    res.end(JSON.stringify(body))
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0
      const parts: Buffer[] = []
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        // 限制请求体，防御超大 payload
        if (size > 1024 * 1024) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        parts.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
      req.on('error', reject)
    })
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const origin = req.headers.origin as string | undefined
    const url = req.url ?? '/'

    // CORS 预检
    if (req.method === 'OPTIONS') {
      if (!this.isAllowedOrigin(origin)) {
        this.sendJson(res, 403, { ok: false, error: 'forbidden origin' })
        return
      }
      this.sendJson(res, 204, {}, origin)
      return
    }

    // 非扩展来源一律拒绝
    if (!this.isAllowedOrigin(origin)) {
      this.sendJson(res, 403, { ok: false, error: '只允许浏览器扩展调用' })
      return
    }

    const parsePath = new URL(url, 'http://127.0.0.1')
    const path = parsePath.pathname

    try {
      if (req.method === 'GET' && path === '/api/health') {
        this.sendJson(res, 200, {
          ok: true,
          name: 'FluxGet',
          version: this.handlers.getVersion(),
          port: this.actualPort,
          protocol: '1.0'
        }, origin)
        return
      }

      // 换取 token：只有通过上述 Origin 校验的扩展才能拿到
      if (req.method === 'GET' && path === '/api/token') {
        this.sendJson(res, 200, { ok: true, token: this.token }, origin)
        return
      }

      if (req.method === 'GET' && path === '/api/tasks') {
        this.sendJson(res, 200, { ok: true, tasks: this.handlers.listTasks() }, origin)
        return
      }

      // 以下为写操作，需校验 token
      const provided = (req.headers['x-fluxget-token'] as string | undefined) ?? ''
      if (provided !== this.token) {
        this.sendJson(res, 401, { ok: false, error: 'token 无效或未携带' })
        return
      }

      if (req.method === 'POST' && (path === '/api/tasks' || path === '/api/quick-download')) {
        const raw = await this.readBody(req)
        let payload: Record<string, unknown> = {}
        if (raw) {
          try {
            payload = JSON.parse(raw) as Record<string, unknown>
          } catch {
            this.sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }, origin)
            return
          }
        }

        const referrer = typeof payload.referrer === 'string' ? payload.referrer : undefined
        const dirPath = typeof payload.dirPath === 'string' ? payload.dirPath : undefined
        const fileName = typeof payload.fileName === 'string' ? payload.fileName : undefined

        if (path === '/api/quick-download') {
          const target = typeof payload.url === 'string' ? payload.url : ''
          if (!target) {
            this.sendJson(res, 400, { ok: false, error: '缺少 url' }, origin)
            return
          }
          const r = await this.handlers.createSingle({ url: target, fileName, dirPath, referrer })
          this.sendJson(res, r.ok ? 200 : 400, { ok: r.ok, id: r.id, error: r.error }, origin)
          return
        }

        const urls = Array.isArray(payload.urls)
          ? (payload.urls as unknown[]).filter((u): u is string => typeof u === 'string')
          : []
        if (urls.length === 0) {
          this.sendJson(res, 400, { ok: false, error: '缺少 urls' }, origin)
          return
        }
        const r = await this.handlers.createTasks({ urls, fileName, dirPath, referrer })
        this.sendJson(res, r.ok ? 200 : 400, { ok: r.ok, ids: r.ids, error: r.error }, origin)
        return
      }

      this.sendJson(res, 404, { ok: false, error: '未知接口' }, origin)
    } catch (err) {
      this.sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : '内部错误'
      }, origin)
    }
  }
}

/** 生成扩展可用的端口候选列表 */
export function candidatePorts(base: number, count = 12): number[] {
  return Array.from({ length: count }, (_, i) => base + i)
}

export type { AppSettings }
