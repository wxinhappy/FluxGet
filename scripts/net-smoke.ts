import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DownloadTask } from '../src/main/engine/DownloadTask'
import { SpeedLimiter } from '../src/main/engine/SpeedLimiter'
import { probeResource } from '../src/main/engine/ResourceProbe'
import type { ProxyConfig } from '../src/shared/types'

const TARGET = 'https://registry.npmmirror.com/typescript/-/typescript-5.5.4.tgz'
const workDir = path.join(os.tmpdir(), 'fluxget-net-test')

/** 读取系统代理环境变量，便于验证 CONNECT 隧道实现 */
function systemProxy(): ProxyConfig | undefined {
  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
  if (!raw) return undefined
  try {
    const u = new URL(raw)
    return {
      enabled: true,
      type: 'http',
      host: u.hostname,
      port: Number(u.port) || 80,
      username: u.username || undefined,
      password: u.password || undefined
    }
  } catch {
    return undefined
  }
}

async function main(): Promise<void> {
  await fsp.rm(workDir, { recursive: true, force: true })
  await fsp.mkdir(workDir, { recursive: true })

  const proxy = systemProxy()
  console.log('目标资源: ' + TARGET)
  console.log('系统代理: ' + (proxy ? proxy.host + ':' + proxy.port : '未使用（直连）'))

  const httpOptions = {
    timeout: 30000,
    insecureTLS: true,
    maxRedirects: 8,
    proxy
  }

  const probe = await probeResource(TARGET, httpOptions)
  console.log('')
  console.log('探测结果:')
  console.log('  文件名        ' + probe.fileName)
  console.log('  大小          ' + probe.totalSize + ' 字节')
  console.log('  支持 Range    ' + probe.supportsRange)
  console.log('  类型          ' + probe.contentType)
  console.log('  最终 URL      ' + probe.finalUrl)
  console.log('')

  if (!probe.supportsRange || probe.totalSize <= 0) {
    console.log('[FAIL] 该资源不支持 Range，无法验证多线程下载')
    process.exit(1)
  }

  const task = new DownloadTask({
    id: 'net-1',
    url: TARGET,
    fileName: probe.fileName,
    dirPath: workDir,
    connections: 8,
    totalSize: probe.totalSize,
    supportsRange: probe.supportsRange,
    createdAt: Date.now(),
    httpOptions,
    globalLimiter: new SpeedLimiter(0),
    taskLimiter: new SpeedLimiter(0),
    maxRetries: 5,
    callbacks: { onPersist: () => undefined, onStateChange: () => undefined }
  })

  task.resume()
  const started = Date.now()
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    if (task.Status === 'completed' || task.Status === 'failed') break
    await task.tick()
    await new Promise((r) => setTimeout(r, 120))
  }
  const seconds = (Date.now() - started) / 1000

  const filePath = path.join(workDir, probe.fileName)
  let fileSize = 0
  let magic = ''
  try {
    const buf = await fsp.readFile(filePath)
    fileSize = buf.length
    magic = buf.subarray(0, 2).toString('hex')
  } catch {
    /* 文件不存在时保持 0 */
  }

  console.log('下载结果:')
  console.log('  状态          ' + task.Status)
  console.log('  耗时          ' + seconds.toFixed(2) + ' 秒')
  console.log('  分片数        ' + task.getSnapshot().chunks.length)
  console.log('  文件大小      ' + fileSize + ' / 预期 ' + probe.totalSize)
  console.log('  文件魔数      ' + magic + (magic === '1f8b' ? ' (gzip 校验通过)' : ' (异常)'))
  console.log('  平均速度      ' + (fileSize / 1024 / Math.max(0.001, seconds)).toFixed(1) + ' KB/s')
  if (task.getSnapshot().errorMessage) console.log('  错误信息      ' + task.getSnapshot().errorMessage)

  const ok = task.Status === 'completed' && fileSize === probe.totalSize && magic === '1f8b'
  console.log('')
  console.log(ok ? '[PASS] 真实 CDN 多线程下载通过（含 302 重定向穿透）' : '[FAIL] 真实网络下载未通过')

  await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  process.exit(ok ? 0 : 1)
}

void main().catch((err) => {
  console.error('测试异常:', err instanceof Error ? err.message : err)
  process.exit(1)
})
