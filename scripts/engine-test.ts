import http from 'node:http'
import crypto from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DownloadTask } from '../src/main/engine/DownloadTask'
import { SpeedLimiter } from '../src/main/engine/SpeedLimiter'
import { DownloadEngine } from '../src/main/engine/DownloadEngine'
import type { TaskRecord } from '../src/main/engine/DownloadEngine'
import { probeResource } from '../src/main/engine/ResourceProbe'
import { defaultSettings } from '../src/main/store/Settings'
import type { AppSettings, ChunkState } from '../src/shared/types'

const SIZE = 24 * 1024 * 1024
const payload = crypto.randomBytes(SIZE)
const expectedHash = crypto.createHash('sha256').update(payload).digest('hex')
const workDir = path.join(os.tmpdir(), 'fluxget-engine-test')

async function fileSha256(p: string): Promise<string> {
  const buf = await fsp.readFile(p)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 支持 Range 的本地测试服务器，可人为节流以观察多线程表现 */
function startServer(): Promise<{ port: number; close: () => void; served: () => number }> {
  let servedBytes = 0
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    const range = req.headers.range

    const write = (buf: Buffer): void => {
      servedBytes += buf.length
    }

    if (url.indexOf('/norange') === 0) {
      res.writeHead(200, {
        'Content-Length': String(SIZE),
        'Content-Type': 'application/octet-stream'
      })
      write(payload)
      res.end(payload)
      return
    }

    if (range && range.indexOf('bytes=') === 0) {
      const nums = range.slice('bytes='.length).split('-')
      let start = Number(nums[0])
      let end = nums[1] ? Number(nums[1]) : SIZE - 1
      if (!Number.isFinite(start)) start = 0
      if (!Number.isFinite(end) || end >= SIZE) end = SIZE - 1
      if (start > end) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + SIZE })
        res.end()
        return
      }
      res.writeHead(206, {
        'Content-Range': 'bytes ' + start + '-' + end + '/' + SIZE,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Type': 'application/octet-stream'
      })
      write(payload.subarray(start, end + 1))
      res.end(payload.subarray(start, end + 1))
      return
    }

    write(payload)
    res.writeHead(200, {
      'Content-Length': String(SIZE),
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="fluxget-test.bin"'
    })
    res.end(payload)
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ port, close: () => server.close(), served: () => servedBytes })
    })
  })
}

function makeTask(
  id: string,
  url: string,
  fileName: string,
  totalSize: number,
  supportsRange: boolean,
  globalLimiter: SpeedLimiter,
  taskLimiter: SpeedLimiter,
  chunks?: ChunkState[]
): DownloadTask {
  return new DownloadTask({
    id,
    url,
    fileName,
    dirPath: workDir,
    connections: 8,
    totalSize,
    supportsRange,
    createdAt: Date.now(),
    chunks,
    httpOptions: { timeout: 20000, insecureTLS: true, maxRedirects: 5 },
    globalLimiter,
    taskLimiter,
    maxRetries: 5,
    callbacks: { onPersist: () => undefined, onStateChange: () => undefined }
  })
}

/** 轮询直到任务终态或超时 */
async function waitFinish(task: DownloadTask, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (task.Status === 'completed' || task.Status === 'failed') return
    await task.tick()
    await new Promise((r) => setTimeout(r, 120))
  }
}

const results: string[] = []
function record(name: string, ok: boolean, extra = ''): void {
  results.push((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''))
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (extra ? '  -> ' + extra : ''))
}

async function main(): Promise<void> {
  await fsp.rm(workDir, { recursive: true, force: true })
  await fsp.mkdir(workDir, { recursive: true })

  const { port, close, served } = await startServer()
  const baseUrl = 'http://127.0.0.1:' + port
  console.log('测试服务器已启动: ' + baseUrl)
  console.log('样本文件: ' + (SIZE / 1024 / 1024).toFixed(1) + ' MB  sha256=' + expectedHash.slice(0, 16) + '...')

  // ---- 用例 1：资源探测 ----
  const probe = await probeResource(baseUrl + '/file.bin', { timeout: 15000 })
  record(
    '资源探测（大小与 Range 能力）',
    probe.totalSize === SIZE && probe.supportsRange,
    'size=' + probe.totalSize + ' range=' + probe.supportsRange + ' name=' + probe.fileName
  )

  // ---- 用例 2：8 线程分片下载完整性 ----
  const g0 = new SpeedLimiter(0)
  const t0 = new SpeedLimiter(0)
  const taskA = makeTask('a', baseUrl + '/file.bin', 'multi-thread.bin', SIZE, true, g0, t0)
  taskA.resume()
  const startA = Date.now()
  await waitFinish(taskA, 60000)
  const elapsedA = (Date.now() - startA) / 1000
  const hashA = await fileSha256(path.join(workDir, 'multi-thread.bin'))
  record(
    '8 线程分片下载 + 数据完整性',
    taskA.Status === 'completed' && hashA === expectedHash,
    taskA.Status + '  ' + elapsedA.toFixed(2) + 's  分片数=' + taskA.getSnapshot().chunks.length
  )

  // ---- 用例 3：断点续传（限速 1MB/s，确保能在下载中途暂停）----
  const g1 = new SpeedLimiter(0)
  const limited = new SpeedLimiter(1024 * 1024)
  const taskB = makeTask('b', baseUrl + '/file.bin', 'resume.bin', SIZE, true, g1, limited)
  taskB.resume()
  await new Promise((r) => setTimeout(r, 1300))
  await taskB.tick()
  await taskB.pause()

  const snapPaused = taskB.getSnapshot()
  const pausedBytes = snapPaused.downloadedSize
  const resumedChunks = snapPaused.chunks.map((c) => ({ ...c }))
  record(
    '暂停时保留断点状态',
    snapPaused.status === 'paused' && pausedBytes > 0 && pausedBytes < SIZE,
    '已下载 ' + pausedBytes + ' / ' + SIZE + ' 字节（' + ((pausedBytes / SIZE) * 100).toFixed(1) + '%）'
  )

  const servedAtResumeStart = served()
  const g1r = new SpeedLimiter(0)
  const t1r = new SpeedLimiter(0)
  const taskC = makeTask('c', baseUrl + '/file.bin', 'resume.bin', SIZE, true, g1r, t1r, resumedChunks)
  taskC.resume()
  await waitFinish(taskC, 60000)
  const hashC = await fileSha256(path.join(workDir, 'resume.bin'))
  record(
    '断点续传后数据完整无错位',
    taskC.Status === 'completed' && hashC === expectedHash,
    taskC.Status + '  复用分片 ' + resumedChunks.filter((c) => c.downloaded > 0).length + ' 个'
  )

  // 续传阶段客户端真实写入量应接近剩余部分，而不是重新接收整个文件
  const remaining = SIZE - pausedBytes
  const incrementalBytes = taskC.totalReceived
  const waste = incrementalBytes / Math.max(1, remaining)
  record(
    '续传仅拉取缺失字节（未重复传输已完成部分）',
    waste > 0.9 && waste < 1.1,
    '续传实际写入 ' + (incrementalBytes / 1024 / 1024).toFixed(2) + ' MB，缺口 ' + (remaining / 1024 / 1024).toFixed(2) + ' MB，比值 ' + waste.toFixed(3)
  )

  // ---- 用例 4：不支持 Range 时降级单连接 ----
  const g2 = new SpeedLimiter(0)
  const t2 = new SpeedLimiter(0)
  const taskD = makeTask('d', baseUrl + '/norange', 'single.bin', SIZE, false, g2, t2)
  taskD.resume()
  await waitFinish(taskD, 60000)
  const hashD = await fileSha256(path.join(workDir, 'single.bin'))
  record(
    '不支持 Range 时单线程降级下载',
    taskD.Status === 'completed' && hashD === expectedHash,
    taskD.Status
  )

  // ---- 用例 5：限速器精度 ----
  const limiter = new SpeedLimiter(512 * 1024)
  const measureStart = Date.now()
  let consumed = 0
  const targetBytes = 3 * 1024 * 1024
  while (consumed < targetBytes) {
    const step = Math.min(64 * 1024, targetBytes - consumed)
    await limiter.consume(step)
    consumed += step
  }
  const seconds = (Date.now() - measureStart) / 1000
  const realBps = consumed / seconds
  const ratio = realBps / (512 * 1024)
  record(
    '令牌桶限速精度（目标 512 KB/s）',
    ratio > 0.7 && ratio < 1.3,
    '实测 ' + (realBps / 1024 / 1024).toFixed(2) + ' MB/s  偏差比=' + ratio.toFixed(2)
  )

  // ---- 用例 6：DownloadEngine 端到端（探测 -> 调度 -> 完成 -> 落盘）----
  const persisted: TaskRecord[][] = []
  const engineSettings: AppSettings = { ...defaultSettings(), downloadDir: workDir, connections: 8 }
  const engine = new DownloadEngine({
    getSettings: () => engineSettings,
    onUpdate: () => undefined,
    onNotify: () => undefined,
    onPersist: (recs) => persisted.push(recs.map((r) => ({ ...r, chunks: r.chunks.map((c) => ({ ...c })) })))
  })
  engine.start()

  const created = await engine.createTask({ url: baseUrl + '/file.bin' })
  let finalSnap = engine.getSnapshots().find((s) => s.id === created.id)
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    finalSnap = engine.getSnapshots().find((s) => s.id === created.id)
    if (finalSnap && (finalSnap.status === 'completed' || finalSnap.status === 'failed')) break
    await new Promise((r) => setTimeout(r, 150))
  }
  const engineHash = await fileSha256(path.join(workDir, finalSnap?.fileName ?? '')).catch(() => '')
  record(
    'DownloadEngine 端到端创建并完成',
    !!created.ok && finalSnap?.status === 'completed' && engineHash === expectedHash,
    'status=' + finalSnap?.status + '  file=' + finalSnap?.fileName
  )

  const lastRecords = persisted[persisted.length - 1] ?? []
  const targetRecord = lastRecords.find((r) => r.id === created.id)
  record(
    '断点信息落盘（含分片状态）',
    !!targetRecord && targetRecord.status === 'completed' && targetRecord.chunks.length > 0,
    '记录数=' + lastRecords.length + '  分片数=' + (targetRecord?.chunks.length ?? 0)
  )

  await engine.stop()

  // ---- 用例 7：冷启动恢复（loadRecords 从断点重建任务）----
  const engine2 = new DownloadEngine({
    getSettings: () => engineSettings,
    onUpdate: () => undefined,
    onNotify: () => undefined,
    onPersist: () => undefined
  })
  const partialRecord: TaskRecord | undefined = targetRecord
  if (partialRecord) {
    // 伪装成「下载到一半被中断」的记录：把第一个分片改为未完成
    const chunks = partialRecord.chunks.map((c) => ({ ...c }))
    if (chunks.length > 0) {
      chunks[0] = { ...chunks[0], downloaded: 0, status: 'running' }
    }
    engine2.loadRecords([{ ...partialRecord, status: 'downloading', chunks }])
  }
  const restoredSnap = engine2.getSnapshots()[0]
  record(
    '冷启动恢复：任务重建且进度保留',
    !!restoredSnap && restoredSnap.status === 'paused' && restoredSnap.chunks.length > 0 && restoredSnap.totalSize === SIZE,
    'status=' + restoredSnap?.status + '  已恢复 ' + (((restoredSnap?.downloadedSize ?? 0) / SIZE) * 100).toFixed(1) + '%  分片 ' + (restoredSnap?.chunks.length ?? 0) + ' 个'
  )

  const restoredStats = engine2.getStats()
  record(
    '全局统计可用',
    restoredStats.taskCountByStatus.paused === 1 && restoredStats.totalDownloadedBytes > 0,
    'paused=' + restoredStats.taskCountByStatus.paused + '  已接收=' + restoredStats.totalDownloadedBytes
  )

  close()

  console.log('')
  console.log('===== 测试结果 =====')
  for (const r of results) console.log('  ' + r)
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log('')
  console.log(failed === 0 ? '全部通过' : failed + ' 项失败')

  await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  process.exit(failed === 0 ? 0 : 1)
}

void main().catch((err) => {
  console.error('测试异常:', err)
  process.exit(1)
})
