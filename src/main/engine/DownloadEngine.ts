import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { DownloadTask } from './DownloadTask'
import { SpeedLimiter } from './SpeedLimiter'
import { probeResource, sanitizeFileName } from './ResourceProbe'
import type { HttpRequestOptions } from './HttpClient'
import { BROADCAST_INTERVAL, DEFAULT_MAX_ACTIVE_TASKS, DEFAULT_USER_AGENT } from '@shared/constants'
import type {
  AppSettings,
  CreateTaskPayload,
  EngineStats,
  ProxyConfig,
  TaskSnapshot,
  TaskStatus,
  ChunkState,
  ProbeResult
} from '@shared/types'

/** 落盘的断点记录 */
export interface TaskRecord {
  id: string
  url: string
  fileName: string
  dirPath: string
  totalSize: number
  supportsRange: boolean
  contentType?: string
  connections: number
  createdAt: number
  completedAt?: number
  status: TaskStatus
  chunks: ChunkState[]
  retryCount: number
  errorMessage?: string
}

export interface EngineCallbacks {
  /** 状态广播（含快照数组） */
  onUpdate: (tasks: TaskSnapshot[], stats: EngineStats) => void
  /** 任务结束时通知UI */
  onNotify: (payload: { title: string; body: string }) => void
  /** 请求持久化所有任务断点 */
  onPersist: (records: TaskRecord[]) => void
  /** 读取当前生效配置 */
  getSettings: () => AppSettings
}

/**
 * 下载引擎：负责任务生命周期、并发调度、限速、全局统计与广播。
 * 本身不依赖 electron，主进程与自测脚本可共用。
 */
export class DownloadEngine {
  private tasks = new Map<string, DownloadTask>()
  private globalLimiter = new SpeedLimiter(0)
  private taskLimiters = new Map<string, SpeedLimiter>()
  private timer: NodeJS.Timeout | null = null
  private previousStatus = new Map<string, TaskStatus>()

  constructor(private readonly callbacks: EngineCallbacks) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, BROADCAST_INTERVAL)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 应用启动时加载历史断点。
   * 中断的下载统一恢复为「已暂停」，由用户决定是否继续，避免意外占用带宽。
   */
  loadRecords(records: TaskRecord[]): void {
    for (const r of records) {
      const forRestart: Record<string, boolean> = { downloading: true, pending: true, probing: true }
      const status: TaskStatus = forRestart[r.status] ? 'paused' : r.status
      const task = new DownloadTask({
        id: r.id,
        url: r.url,
        fileName: r.fileName,
        dirPath: r.dirPath,
        connections: r.connections,
        totalSize: r.totalSize,
        supportsRange: r.supportsRange,
        contentType: r.contentType,
        createdAt: r.createdAt,
        chunks: r.chunks,
        retryCount: r.retryCount,
        httpOptions: this.buildHttpOptions(),
        globalLimiter: this.globalLimiter,
        taskLimiter: this.limiterFor(r.id),
        maxRetries: this.callbacks.getSettings().maxRetries,
        callbacks: {
          onPersist: () => this.persistAll(),
          onStateChange: () => this.pump()
        }
      })
      if (status === 'completed') task.forceCompleted(r.completedAt)
      else if (status === 'paused') task.forcePaused()
      this.tasks.set(r.id, task)
    }
  }

  /** 探测 URL 但不立即创建任务（供新建任务窗口实时预览文件信息） */
  async probe(url: string): Promise<ProbeResult> {
    try {
      const settings = this.callbacks.getSettings()
      const info = await probeResource(url, {
        timeout: settings.requestTimeout,
        insecureTLS: settings.insecureTLS,
        proxy: settings.proxy,
        maxRedirects: 8
      })
      return {
        ok: true,
        fileName: info.fileName,
        totalSize: info.totalSize,
        supportsRange: info.supportsRange,
        contentType: info.contentType
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 创建任务 */
  async createTask(payload: CreateTaskPayload): Promise<{ ok: boolean; id?: string; error?: string }> {
    const settings = this.callbacks.getSettings()
    const dirPath = payload.dirPath || settings.downloadDir

    let probeInfo
    try {
      probeInfo = await probeResource(payload.url, {
        timeout: settings.requestTimeout,
        insecureTLS: settings.insecureTLS,
        proxy: settings.proxy
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    const fileName = uniqueName(dirPath, sanitizeFileName(payload.fileName || probeInfo.fileName))
    const id = randomUUID()
    const baseOptions = this.buildHttpOptions()
    if (payload.referrer) {
      baseOptions.headers = { ...baseOptions.headers, Referer: payload.referrer }
    }

    const task = new DownloadTask({
      id,
      url: payload.url,
      fileName,
      dirPath,
      connections: payload.connections ?? settings.connections,
      totalSize: probeInfo.totalSize,
      supportsRange: probeInfo.supportsRange,
      contentType: probeInfo.contentType,
      createdAt: Date.now(),
      httpOptions: baseOptions,
      globalLimiter: this.globalLimiter,
      taskLimiter: this.limiterFor(id),
      maxRetries: settings.maxRetries,
      callbacks: {
        onPersist: () => this.persistAll(),
        onStateChange: () => this.pump()
      }
    })

    this.tasks.set(id, task)
    this.persistAll()
    task.resume()
    this.pump()
    return { ok: true, id }
  }

  /** 单链接快速下载，支持来源页（用于突破防盗链） */
  async createSingle(payload: {
    url: string
    fileName?: string
    dirPath?: string
    referrer?: string
  }): Promise<{ ok: boolean; id?: string; error?: string }> {
    return this.createTask({
      url: payload.url,
      fileName: payload.fileName,
      dirPath: payload.dirPath,
      referrer: payload.referrer
    })
  }

  async batchCreateTasks(
    urls: string[],
    opts?: { referrer?: string; dirPath?: string; fileName?: string }
  ): Promise<{ ok: boolean; ids?: string[]; error?: string }> {
    const ids: string[] = []
    let lastError = ''
    for (const url of urls) {
      const trimmed = url.trim()
      if (trimmed.length === 0) continue
      const payload: CreateTaskPayload = { url: trimmed, referrer: opts?.referrer, dirPath: opts?.dirPath }
      // 多链接时不复用同一文件名，避免覆盖
      if (opts?.fileName && urls.length === 1) payload.fileName = opts.fileName
      const r = await this.createTask(payload)
      if (r.ok && r.id) ids.push(r.id)
      else if (r.error) lastError = r.error
    }
    return { ok: ids.length > 0, ids, error: lastError }
  }

  async pauseTask(id: string): Promise<void> {
    const t = this.tasks.get(id)
    if (t) await t.pause()
    this.pump()
    this.persistAll()
  }

  async resumeTask(id: string): Promise<void> {
    const t = this.tasks.get(id)
    if (!t || t.finished) return
    t.resume()
    this.pump()
  }

  /** 重新下载：丢弃已下载数据与文件，从零开始 */
  async redoTask(id: string): Promise<void> {
    const t = this.tasks.get(id)
    if (!t) return
    const snap = t.getSnapshot()
    await t.cancel(true)
    this.tasks.delete(id)
    this.taskLimiters.delete(id)
    await this.createTask({
      url: snap.url,
      dirPath: snap.dirPath,
      fileName: snap.fileName,
      connections: snap.connections
    })
  }

  async cancelTask(id: string, deleteFile: boolean): Promise<void> {
    const t = this.tasks.get(id)
    if (!t) return
    await t.cancel(deleteFile)
    this.tasks.delete(id)
    this.taskLimiters.delete(id)
    this.pump()
    this.persistAll()
  }

  clearFinished(): void {
    for (const [id, t] of this.tasks) {
      if (t.finished) {
        this.tasks.delete(id)
        this.taskLimiters.delete(id)
      }
    }
    this.persistAll()
  }

  setTaskConnections(id: string, n: number): void {
    this.tasks.get(id)?.setConnections(n)
  }

  getSnapshots(): TaskSnapshot[] {
    return [...this.tasks.values()].map((t) => t.getSnapshot())
  }

  getStats(): EngineStats {
    const snaps = this.getSnapshots()
    const counting: TaskStatus[] = [
      'pending',
      'probing',
      'downloading',
      'paused',
      'completed',
      'failed',
      'canceled'
    ]
    const taskCountByStatus = Object.fromEntries(counting.map((s) => [s, 0])) as Record<TaskStatus, number>
    let totalSpeed = 0
    let activeCount = 0
    let totalDownloadedBytes = 0

    for (const s of snaps) {
      taskCountByStatus[s.status] += 1
      totalSpeed += s.speed
      totalDownloadedBytes += s.downloadedSize
      if (s.status === 'downloading') activeCount += 1
    }
    return { activeCount, totalSpeed, totalDownloadedBytes, taskCountByStatus }
  }

  /** 应用配置变化时同步限速等参数 */
  applySettings(settings: AppSettings): void {
    this.globalLimiter.setLimit(settings.globalSpeedLimit)
    const limiters = [...this.taskLimiters.values()]
    for (const l of limiters) l.setLimit(settings.taskSpeedLimit)
  }

  async pauseAll(): Promise<void> {
    for (const t of this.tasks.values()) await t.pause()
  }

  async shutdown(): Promise<void> {
    this.stop()
    for (const t of this.tasks.values()) await t.pause()
    this.persistAll()
  }

  // ---------- 内部 ----------

  private buildHttpOptions(): Omit<HttpRequestOptions, 'method' | 'signal'> {
    const settings = this.callbacks.getSettings()
    const proxy: ProxyConfig | undefined = settings.proxy?.enabled ? settings.proxy : undefined
    return {
      timeout: settings.requestTimeout,
      insecureTLS: settings.insecureTLS,
      maxRedirects: 8,
      proxy,
      headers: { 'User-Agent': settings.userAgent || DEFAULT_USER_AGENT } as Record<string, string>
    }
  }

  private limiterFor(id: string): SpeedLimiter {
    let l = this.taskLimiters.get(id)
    if (!l) {
      l = new SpeedLimiter(this.callbacks.getSettings().taskSpeedLimit)
      this.taskLimiters.set(id, l)
    }
    return l
  }

  /** 并发调度：活跃任务不足时自动启动排队任务 */
  private pump(): void {
    const settings = this.callbacks.getSettings()
    const max = Math.max(1, settings.maxActiveTasks ?? DEFAULT_MAX_ACTIVE_TASKS)
    let active = 0
    for (const t of this.tasks.values()) {
      if (t.Status === 'downloading') active += 1
    }
    if (active >= max) return

    for (const t of this.tasks.values()) {
      if (active >= max) break
      if (t.Status === 'pending') {
        t.resume()
        active += 1
      } else if (t.Status === 'probing') {
        active += 1
      }
    }
  }

  private async tick(): Promise<void> {
    const active = [...this.tasks.values()].filter((t) => t.Status === 'downloading')
    await Promise.all(active.map((t) => t.tick().catch(() => undefined)))

    // 检测状态迁移，触发完成通知
    for (const t of this.tasks.values()) {
      const now = t.Status
      const before = this.previousStatus.get(t.id)
      if (before && before !== now) {
        if (now === 'completed') {
          this.callbacks.onNotify({ title: '下载完成', body: t.fileName })
        } else if (now === 'failed') {
          const msg = t.getSnapshot().errorMessage || '未知错误'
          this.callbacks.onNotify({ title: '下载失败', body: t.fileName + '：' + msg })
        }
      }
      this.previousStatus.set(t.id, now)
    }

    this.broadcast()
  }

  private broadcast(): void {
    this.callbacks.onUpdate(this.getSnapshots(), this.getStats())
  }

  private persistAll(): void {
    const records: TaskRecord[] = [...this.tasks.values()].map((t) => {
      const s = t.getSnapshot()
      return {
        id: s.id,
        url: s.url,
        fileName: s.fileName,
        dirPath: s.dirPath,
        totalSize: s.totalSize,
        supportsRange: s.supportsRange,
        contentType: s.contentType,
        connections: s.connections,
        createdAt: s.createdAt,
        completedAt: s.completedAt,
        status: s.status,
        chunks: s.chunks,
        retryCount: s.retryCount,
        errorMessage: s.errorMessage
      }
    })
    this.callbacks.onPersist(records)
  }
}

/** 生成不覆盖现有文件的目标文件名，格式 xxx (1).ext */
function uniqueName(dirPath: string, fileName: string): string {
  if (!existsSync(path.join(dirPath, fileName))) return fileName
  const dot = fileName.lastIndexOf('.')
  const base = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ''
  for (let i = 1; i < 1000; i += 1) {
    const candidate = base + ' (' + i + ')' + ext
    if (!existsSync(path.join(dirPath, candidate))) return candidate
  }
  return base + ' (' + Date.now() + ')' + ext
}
