import http from 'node:http'
import assert from 'node:assert'
import { HttpBridge } from '../src/main/bridge/HttpBridge'

const results: string[] = []
function record(name: string, ok: boolean, extra = ''): void {
  results.push((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''))
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (extra ? ' -> ' + extra : ''))
}

/** 本地测试文件服务器（模拟浏览器要下载的资源） */
function startFileServer(): Promise<{ port: number; close: () => void }> {
  const payload = Buffer.alloc(5 * 1024 * 1024, 0x61)
  const server = http.createServer((req, res) => {
    const range = req.headers.range
    if (range && range.indexOf('bytes=') === 0) {
      const nums = range.slice('bytes='.length).split('-')
      const start = Number(nums[0])
      let end = nums[1] ? Number(nums[1]) : payload.length - 1
      if (!Number.isFinite(end) || end >= payload.length) end = payload.length - 1
      res.writeHead(206, {
        'Content-Range': 'bytes ' + start + '-' + end + '/' + payload.length,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1)
      })
      res.end(payload.subarray(start, end + 1))
      return
    }
    res.writeHead(200, {
      'Content-Length': String(payload.length),
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream'
    })
    res.end(payload)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as { port: number }).port, close: () => server.close() })
    })
  })
}

interface ReqResult {
  status: number
  body: Record<string, unknown>
}

function request(
  port: number,
  method: string,
  path: string,
  opts: { origin?: string; token?: string; body?: unknown } = {}
): Promise<ReqResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (opts.origin) headers.Origin = opts.origin
    if (opts.token) headers['X-FluxGet-Token'] = opts.token
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers },
      (res) => {
        const parts: Buffer[] = []
        res.on('data', (c: Buffer) => parts.push(c))
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8')
          let body: Record<string, unknown> = {}
          try {
            body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
          } catch {
            body = { raw: text }
          }
          resolve({ status: res.statusCode ?? 0, body })
        })
      }
    )
    req.on('error', reject)
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body))
    req.end()
  })
}

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

async function main(): Promise<void> {
  const file = await startFileServer()

  const created: string[] = []
  const bridge = new HttpBridge({
    createTasks: async (payload) => {
      created.push(...payload.urls)
      return { ok: true, ids: payload.urls.map((_, i) => 'id-' + i) }
    },
    createSingle: async (payload) => {
      created.push(payload.url)
      return { ok: true, id: 'single-1' }
    },
    listTasks: () => [],
    getVersion: () => '1.0.1-test',
    notify: () => undefined
  })

  const port = await bridge.start(17888)
  record('桥接服务启动并绑定端口', port === 17888, 'port=' + port)

  // 1. 无 Origin 的普通网页请求必须被拒绝（本地 CSRF 防护核心）
  const noOrigin = await request(port, 'GET', '/api/health')
  record(
    '无 Origin 请求被拒绝（防恶意网页）',
    noOrigin.status === 403,
    'status=' + noOrigin.status
  )

  // 2. 恶意网页 Origin 被拒绝
  const evil = await request(port, 'GET', '/api/token', { origin: 'https://evil.example.com' })
  record('普通网页 Origin 被拒绝', evil.status === 403, 'status=' + evil.status)

  // 3. 扩展 Origin 放行
  const health = await request(port, 'GET', '/api/health', { origin: EXT_ORIGIN })
  record(
    '扩展 Origin 健康检查通过',
    health.status === 200 && health.body.name === 'FluxGet',
    'version=' + health.body.version
  )

  // 4. token 换取
  const tokenRes = await request(port, 'GET', '/api/token', { origin: EXT_ORIGIN })
  const token = typeof tokenRes.body.token === 'string' ? tokenRes.body.token : ''
  record('扩展可换取 token', tokenRes.status === 200 && token.length > 20, 'len=' + token.length)

  // 5. 无 token 的写操作被拒绝
  const noToken = await request(port, 'POST', '/api/tasks', {
    origin: EXT_ORIGIN,
    body: { urls: ['http://a/b'] }
  })
  record('缺 token 的写操作被拒绝', noToken.status === 401, 'status=' + noToken.status)

  // 6. 携带 token 创建任务
  const createdRes = await request(port, 'POST', '/api/tasks', {
    origin: EXT_ORIGIN,
    token,
    body: { urls: ['http://example.com/file1.zip', 'http://example.com/file2.zip'] }
  })
  record(
    '携带 token 批量创建任务',
    createdRes.status === 200 && createdRes.body.ok === true && created.length === 2,
    JSON.stringify(createdRes.body)
  )

  // 7. quick-download 单链接
  const quick = await request(port, 'POST', '/api/quick-download', {
    origin: EXT_ORIGIN,
    token,
    body: { url: 'http://example.com/video.mp4', referrer: 'https://example.com/page' }
  })
  record('单链接接管接口', quick.status === 200 && quick.body.ok === true)

  // 8. 任务列表接口
  const list = await request(port, 'GET', '/api/tasks', { origin: EXT_ORIGIN })
  record('任务列表接口', list.status === 200 && Array.isArray(list.body.tasks))

  bridge.stop()

  // 9. 端到端：真实引擎通过桥接创建任务并完成下载
  const { DownloadEngine } = await import('../src/main/engine/DownloadEngine')
  const { defaultSettings } = await import('../src/main/store/Settings')
  const path = await import('node:path')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const crypto = await import('node:crypto')

  const workDir = path.join(os.tmpdir(), 'fluxget-bridge-e2e')
  fs.rmSync(workDir, { recursive: true, force: true })
  fs.mkdirSync(workDir, { recursive: true })

  const payload = Buffer.alloc(5 * 1024 * 1024, 0x61) // 与文件服务器 payload 一致
  const expectedSha = crypto.createHash('sha256').update(payload).digest('hex')
  const settings = { ...defaultSettings(), downloadDir: workDir }

  const engine = new DownloadEngine({
    getSettings: () => settings,
    onUpdate: () => undefined,
    onNotify: () => undefined,
    onPersist: () => undefined
  })
  engine.start()

  const bridge2 = new HttpBridge({
    createTasks: async (p) => engine.batchCreateTasks(p.urls, p),
    createSingle: async (p) => engine.createSingle(p),
    listTasks: () => engine.getSnapshots(),
    getVersion: () => 'test',
    notify: () => undefined
  })
  const port2 = await bridge2.start(0)
  const tok = (await request(port2, 'GET', '/api/token', { origin: EXT_ORIGIN })).body.token as string

  const r = await request(port2, 'POST', '/api/quick-download', {
    origin: EXT_ORIGIN,
    token: tok,
    body: { url: 'http://127.0.0.1:' + file.port + '/e2e.bin', dirPath: workDir }
  })
  const taskId = typeof r.body.id === 'string' ? r.body.id : ''

  let finalStatus = ''
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const snap = engine.getSnapshots().find((s) => s.id === taskId)
    if (snap) {
      finalStatus = snap.status
      if (snap.status === 'completed' || snap.status === 'failed') break
    }
    await new Promise((res) => setTimeout(res, 150))
  }

  const fileBuf = fs.readFileSync(path.join(workDir, 'e2e.bin'))
  const sha = crypto.createHash('sha256').update(fileBuf).digest('hex')
  record(
    '端到端：扩展请求 -> 桥接 -> 引擎 -> 文件落盘',
    finalStatus === 'completed' && sha === expectedSha && fileBuf.length === payload.length,
    'status=' + finalStatus + ' size=' + fileBuf.length
  )

  engine.stop()
  bridge2.stop()
  file.close()

  console.log('')
  console.log('===== 结果 =====')
  for (const line of results) console.log('  ' + line)
  const failed = results.filter((x) => x.startsWith('FAIL')).length
  console.log(failed === 0 ? '全部通过' : failed + ' 项失败')

  fs.rmSync(workDir, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
}

void main().catch((err) => {
  console.error('测试异常:', err instanceof Error ? err.message : err)
  process.exit(1)
})
