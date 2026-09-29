import path from 'node:path'
import { AbortError, httpRequest } from './HttpClient'
import type { HttpRequestOptions } from './HttpClient'
import { ChunkedFileWriter } from './FileWriter'
import type { SpeedLimiter } from './SpeedLimiter'
import type { ChunkState, TaskStatus, TaskSnapshot } from '@shared/types'
import {
  MIN_CHUNK_SIZE,
  MIN_SPLIT_REMAIN,
  RETRY_BASE_DELAY,
  RETRY_MAX_DELAY,
  SPEED_WINDOW_MS
} from '@shared/constants'

export interface TaskCallbacks {
  /** 请求持久化断点信息 */
  onPersist: () => void
  /** 状态发生变化（完成 / 失败），引擎据此调度后续 */
  onStateChange: () => void
}

export interface DownloadTaskInit {
  id: string
  url: string
  fileName: string
  dirPath: string
  connections: number
  totalSize: number
  supportsRange: boolean
  contentType?: string
  createdAt: number
  chunks?: ChunkState[]
  retryCount?: number
  httpOptions: Omit<HttpRequestOptions, 'headers' | 'signal' | 'method'>
  globalLimiter: SpeedLimiter
  taskLimiter: SpeedLimiter
  maxRetries: number
  callbacks: TaskCallbacks
}

interface SpeedSample {
  t: number
  bytes: number
}

/**
 * 单个下载任务的执行体。
 *
 * 能力：多线程分片并发、动态分片抢占、字节级断点续传、失败指数退避重试、双层限速。
 * 该类不依赖 electron，可在纯 Node 环境下单独测试。
 */
export class DownloadTask {
  readonly id: string
  readonly url: string
  readonly fileName: string
  readonly dirPath: string
  readonly savePath: string
  readonly createdAt: number

  totalSize: number
  supportsRange: boolean
  contentType?: string
  retryCount: number

  private chunks: ChunkState[] = []
  private status: TaskStatus = 'pending'
  private connections: number
  private nextChunkId = 0
  private completedAt?: number
  private errorMessage?: string

  private writer!: ChunkedFileWriter
  private aborters = new Map<number, AbortController>()
  private workers = new Map<number, Promise<void>>()
  private samples: SpeedSample[] = []
  private sampleSum = 0
  private receivedBytes = 0
  private lastPersistAt = 0
  private httpOptions: Omit<HttpRequestOptions, 'headers' | 'signal' | 'method'>
  private readonly globalLimiter: import('./SpeedLimiter').SpeedLimiter
  private readonly taskLimiter: import('./SpeedLimiter').SpeedLimiter
  private readonly maxRetries: number
  private readonly callbacks: TaskCallbacks

  constructor(init: DownloadTaskInit) {
    this.id = init.id
    this.url = init.url
    this.fileName = init.fileName
    this.dirPath = init.dirPath
    this.savePath = path.join(init.dirPath, init.fileName)
    this.createdAt = init.createdAt
    this.totalSize = init.totalSize
    this.supportsRange = init.supportsRange
    this.contentType = init.contentType
    this.retryCount = init.retryCount ?? 0
    this.connections = Math.max(1, init.connections)
    this.httpOptions = init.httpOptions
    this.globalLimiter = init.globalLimiter
    this.taskLimiter = init.taskLimiter
    this.maxRetries = init.maxRetries
    this.callbacks = init.callbacks

    if (init.chunks?.length) {
      this.chunks = init.chunks.map((c) => ({ ...c, status: c.status === 'running' ? 'idle' : c.status }))
      this.nextChunkId = Math.max(...this.chunks.map((c) => c.id)) + 1
    }
  }

  get Status(): TaskStatus {
    return this.status
  }

  get finished(): boolean {
    return this.status === 'completed' || this.status === 'failed' || this.status === 'canceled'
  }

  get downloadedSize(): number {
    if (this.status === 'completed') return this.totalSize
    let sum = 0
    for (const c of this.chunks) sum += Math.min(c.downloaded, c.end - c.start + 1)
    return sum
  }

  get progress(): number {
    if (this.totalSize <= 0) return 0
    return Math.min(1, this.downloadedSize / this.totalSize)
  }

  get speed(): number {
    if (this.status !== 'downloading' || this.samples.length === 0) return 0
    const dt = (Date.now() - this.samples[0].t) / 1000
    if (dt < 0.3) return 0
    return Math.round(this.sampleSum / dt)
  }

  get timeLeft(): number {
    const s = this.speed
    if (s <= 0) return 0
    const remain = Math.max(0, this.totalSize - this.downloadedSize)
    return Math.round(remain / s)
  }

  /** 恢复次任务的所有连接 */
  resume(): void {
    if (this.status === 'downloading' || this.finished) return
    this.status = 'downloading'
    this.errorMessage = undefined
    this.pumpWithWriter()
  }

  /** 暂停：中止所有连接并刷盘，保留分片进度供续传 */
  async pause(): Promise<void> {
    if (this.status !== 'downloading') {
      if (this.status === 'pending' || this.status === 'probing') this.status = 'paused'
      return
    }
    this.status = 'paused'
    for (const ac of this.aborters.values()) ac.abort()
    this.aborters.clear()
    await Promise.allSettled([...this.workers.values()])
    this.workers.clear()
    this.clearSamples()
    await this.writer?.flush()
    await this.writer?.close()
    this.stateChanged()
  }

  /** 取消任务，deleteFile=true 时同时删除半成品文件 */
  async cancel(deleteFile = false): Promise<void> {
    this.status = 'canceled'
    for (const ac of this.aborters.values()) ac.abort()
    this.aborters.clear()
    await Promise.allSettled([...this.workers.values()])
    this.workers.clear()
    this.clearSamples()
    if (this.writer) {
      await this.writer.close()
      if (deleteFile) {
        try {
          const { unlink } = await import('node:fs/promises')
          await unlink(this.savePath)
        } catch {
          /* 文件可能不存在，忽略 */
        }
      }
    }
  }

  /** 引擎每次 tick 调用，负责补连接、动态分裂、完成判定与节流落盘 */
  async tick(): Promise<void> {
    const now = Date.now()

    if (this.status !== 'downloading') {
      this.pruneOldSamples()
      return
    }

    this.pruneOldSamples()
    this.tryDynamicSplit()
    this.pump()

    if (this.chunks.length > 0 && this.chunks.every((c) => c.status === 'done')) {
      await this.finish()
      return
    }

    // 所有活动连接都失败且无人可跑 → 判定失败
    if (this.chunks.length > 0 && this.chunks.every((c) => c.status === 'error')) {
      this.status = 'failed'
      this.errorMessage ||= '所有连接失败'
      await this.writer.flush()
      await this.writer.close()
      this.stateChanged()
      return
    }

    if (now - this.lastPersistAt > 2000) {
      this.lastPersistAt = now
      await this.writer.flush()
      this.callbacks.onPersist()
    }
  }

  setConnections(n: number): void {
    const next = Math.max(1, Math.min(32, n))
    if (next === this.connections) return
    this.connections = next
    if (this.status === 'downloading') this.pump()
  }

  /** 从历史记录恢复「已完成」任务时调用 */
  forceCompleted(completedAt?: number): void {
    this.status = 'completed'
    this.completedAt = completedAt ?? Date.now()
    for (const c of this.chunks) {
      if (c.end !== Number.MAX_SAFE_INTEGER) {
        c.downloaded = c.end - c.start + 1
        c.status = 'done'
      }
    }
  }

  /**
   * 从历史记录恢复「已中断」任务时调用。
   * 此时尚不能 resume：文件句柄未就绪，任意分片恢复后才可继续。
   */
  forcePaused(): void {
    if (this.status === 'completed' || this.status === 'failed') return
    for (const c of this.chunks) {
      if (c.status === 'running') c.status = 'idle'
    }
    this.status = 'paused'
  }

  getSnapshot(): TaskSnapshot {
    return {
      id: this.id,
      url: this.url,
      fileName: this.fileName,
      dirPath: this.dirPath,
      savePath: this.savePath,
      totalSize: this.totalSize,
      downloadedSize: this.downloadedSize,
      status: this.status,
      connections: this.connections,
      supportsRange: this.supportsRange,
      resumable: this.supportsRange,
      chunks: this.chunks.map((c) => ({ ...c })),
      createdAt: this.createdAt,
      completedAt: this.completedAt,
      speed: this.speed,
      timeLeft: this.timeLeft,
      retryCount: this.retryCount,
      errorMessage: this.errorMessage,
      contentType: this.contentType
    }
  }

  // ---------- 内部实现 ----------

  private async pumpWithWriter(): Promise<void> {
    try {
      const hasPersisted = this.chunks.length > 0
      this.writer = new ChunkedFileWriter(this.savePath, this.totalSize)
      await this.writer.open(hasPersisted ? 'resume' : 'create')
      this.buildChunks()
      this.pump()
    } catch (err) {
      this.status = 'failed'
      this.errorMessage = err instanceof Error ? err.message : String(err)
      this.stateChanged()
    }
  }

  private buildChunks(): void {
    if (this.chunks.length > 0) {
      for (const c of this.chunks) if (c.status === 'running') c.status = 'idle'
      return
    }

    const total = this.totalSize

    // 未知大小或服务端不支持 Range → 单连接流式下载
    if (!this.supportsRange || total <= MIN_CHUNK_SIZE) {
      this.chunks = [{ id: 0, start: 0, end: total > 0 ? total - 1 : Number.MAX_SAFE_INTEGER, downloaded: 0, status: 'idle' }]
      this.nextChunkId = 1
      return
    }

    const count = Math.max(1, Math.min(this.connections, Math.floor(total / MIN_CHUNK_SIZE)))
    const base = Math.floor(total / count)
    for (let i = 0; i < count; i += 1) {
      const start = i * base
      const end = i === count - 1 ? total - 1 : start + base - 1
      this.chunks.push({ id: i, start, end, downloaded: 0, status: 'idle' })
    }
    this.nextChunkId = count
  }

  private pump(): void {
    for (const chunk of this.chunks) {
      if (chunk.status !== 'idle' && chunk.status !== 'error') continue
      if (this.workers.size >= this.connections) break
      if (isComplete(chunk)) {
        chunk.status = 'done'
        continue
      }
      this.workers.set(chunk.id, this.runChunk(chunk))
    }
  }

  /** 动态分裂：把剩余量最大的慢连接一分为二，用空闲 connections 抢占 */
  private tryDynamicSplit(): void {
    if (!this.supportsRange || this.totalSize <= 0) return
    if (this.workers.size >= this.connections) return

    let donor: ChunkState | null = null
    let maxRemain = 0
    for (const c of this.chunks) {
      if (c.status !== 'running') continue
      const remain = c.end - (c.start + c.downloaded) + 1
      if (remain > maxRemain) {
        maxRemain = remain
        donor = c
      }
    }
    if (!donor || maxRemain < MIN_SPLIT_REMAIN * 2) return

    const from = donor.start + donor.downloaded
    const mid = from + Math.floor(maxRemain / 2)
    if (mid <= from) return

    const newChunk: ChunkState = {
      id: this.nextChunkId++,
      start: mid,
      end: donor.end,
      downloaded: 0,
      status: 'idle'
    }
    // 缩窄 donor 的上界，正在传输的连接会在触及新边界时自动停止
    donor.end = mid - 1
    if (isComplete(donor)) donor.status = 'done'
    this.chunks.push(newChunk)
  }

  private async runChunk(chunk: ChunkState): Promise<void> {
    let attempt = 0

    while (this.status === 'downloading') {
      const from = chunk.start + chunk.downloaded
      if (from > chunk.end) {
        chunk.status = 'done'
        break
      }

      const ac = new AbortController()
      this.aborters.set(chunk.id, ac)
      chunk.status = 'running'

      try {
        const headers: Record<string, string> = {}
        if (this.supportsRange) headers.Range = `bytes=${from}-${chunk.end}`

        const res = await httpRequest(this.url, {
          ...this.httpOptions,
          method: 'GET',
          headers,
          signal: ac.signal
        })

        if (res.statusCode === 416) {
          throw new Error('服务端拒绝该字节区间（416）')
        }
        if (res.statusCode >= 400) {
          throw new Error(`HTTP ${res.statusCode}`)
        }
        if (res.statusCode === 200 && this.supportsRange) {
          // 服务端忽略 Range 头，退化成单连接全量下载
          res.stream.destroy()
          await this.degradeToSingleThread()
          return
        }

        let stopped = false
        for await (const rawBuf of res.stream) {
          if (ac.signal.aborted || this.status !== 'downloading') {
            stopped = true
            break
          }
          const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf)
          const limitReached = await this.writeAccountingBoundary(chunk, buf)
          if (limitReached) {
            chunk.status = 'done'
            break
          }
        }

        if (ac.signal.aborted || this.status !== 'downloading') {
          chunk.status = 'idle'
          return
        }
        if (stopped) {
          chunk.status = 'idle'
          return
        }

        if (isComplete(chunk)) {
          chunk.status = 'done'
          return
        }

        // 流已结束但分片未写满 → 视为断流，重试续传剩余部分
        attempt += 1
        if (attempt > this.maxRetries) {
          chunk.status = 'error'
          this.errorMessage = `连接重试 ${attempt - 1} 次后仍失败`
          return
        }
        await delay(backoffDelay(attempt))
      } catch (err) {
        if (err instanceof AbortError || ac.signal.aborted || this.status !== 'downloading') {
          chunk.status = 'idle'
          return
        }
        attempt += 1
        this.retryCount += 1
        if (attempt > this.maxRetries) {
          chunk.status = 'error'
          this.errorMessage = err instanceof Error ? err.message : String(err)
          return
        }
        await delay(backoffDelay(attempt))
      } finally {
        this.aborters.delete(chunk.id)
        this.workers.delete(chunk.id)
      }
    }
  }

  /**
   * 写入一个数据块并处理分片边界。
   * @returns true 表示该分片已写满，worker 应结束
   */
  private async writeAccountingBoundary(chunk: ChunkState, buf: Buffer): Promise<boolean> {
    const currentPos = chunk.start + chunk.downloaded
    const chunkEnd = chunk.end
    const allowance = chunkEnd - currentPos + 1

    if (allowance >= buf.length) {
      await this.globalLimiter.consume(buf.length)
      await this.taskLimiter.consume(buf.length)
      await this.writer.writeAt(currentPos, buf)
      chunk.downloaded += buf.length
      this.addSample(buf.length)
      return chunk.start + chunk.downloaded > chunkEnd
    }

    if (allowance <= 0) return true

    const slice = buf.subarray(0, allowance)
    await this.globalLimiter.consume(slice.length)
    await this.taskLimiter.consume(slice.length)
    await this.writer.writeAt(currentPos, slice)
    chunk.downloaded += allowance
    this.addSample(allowance)
    return true
  }

  /** 服务端忽略 Range 头时，退化为单连接全量下载 */
  private async degradeToSingleThread(): Promise<void> {
    this.supportsRange = false
    this.status = 'paused'
    for (const ac of this.aborters.values()) ac.abort()
    this.aborters.clear()
    await Promise.allSettled([...this.workers.values()])
    this.workers.clear()

    await this.writer.close()
    this.chunks = [
      {
        id: 0,
        start: 0,
        end: this.totalSize > 0 ? this.totalSize - 1 : Number.MAX_SAFE_INTEGER,
        downloaded: 0,
        status: 'idle'
      }
    ]
    this.nextChunkId = 1
    this.status = 'downloading'
    await this.writer.open('create')
    this.pump()
  }

  private async finish(): Promise<void> {
    const downloaded = this.downloadedSize
    if (this.totalSize <= 0) this.totalSize = downloaded
    this.status = 'completed'
    this.completedAt = Date.now()
    await this.writer.finalize(this.totalSize)
    await this.writer.flush()
    await this.writer.close()
    this.clearSamples()
    this.stateChanged()
  }

  private addSample(n: number): void {
    this.receivedBytes += n
    this.samples.push({ t: Date.now(), bytes: n })
    this.sampleSum += n
    if (this.samples.length > 4096) this.pruneOldSamples()
  }

  /** 本次会话实际写入磁盘的字节总数（不含复用的历史断点部分） */
  get totalReceived(): number {
    return this.receivedBytes
  }

  private pruneOldSamples(): void {
    const cutoff = Date.now() - SPEED_WINDOW_MS
    while (this.samples.length && this.samples[0].t < cutoff) {
      this.sampleSum -= this.samples[0].bytes
      this.samples.shift()
    }
  }

  private clearSamples(): void {
    this.samples = []
    this.sampleSum = 0
  }

  private stateChanged(): void {
    this.callbacks.onStateChange()
    this.callbacks.onPersist()
  }
}

function isComplete(chunk: ChunkState): boolean {
  return chunk.end !== Number.MAX_SAFE_INTEGER && chunk.downloaded >= chunk.end - chunk.start + 1
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function backoffDelay(attempt: number): number {
  return Math.min(RETRY_MAX_DELAY, RETRY_BASE_DELAY * 2 ** (attempt - 1))
}
