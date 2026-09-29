/**
 * FluxGet 全局共享类型定义
 * 主进程 / Preload / 渲染进程三方共用
 */

/** 任务生命周期状态 */
export type TaskStatus =
  | 'pending' // 排队等待调度
  | 'probing' // 正在探测资源信息（HEAD / Range 试探）
  | 'downloading' // 下载中
  | 'paused' // 已暂停（保留断点状态，可恢复）
  | 'completed' // 已完成
  | 'failed' // 失败
  | 'canceled' // 已取消 / 已删除

/** 单个分片的下载状态 */
export type ChunkStatus = 'idle' | 'running' | 'done' | 'error'

/** 分片描述：[start, end] 双闭区间 */
export interface ChunkState {
  id: number
  start: number
  end: number
  /** 该分片已写入的字节数；下一次续传起点 = start + downloaded */
  downloaded: number
  status: ChunkStatus
}

/** 推送给 UI 的任务快照 */
export interface TaskSnapshot {
  id: string
  url: string
  fileName: string
  dirPath: string
  savePath: string
  totalSize: number
  downloadedSize: number
  status: TaskStatus
  /** 并发连接数 */
  connections: number
  /** 服务端是否支持 Range 断点续传 */
  supportsRange: boolean
  /** 是否可恢复 */
  resumable: boolean
  chunks: ChunkState[]
  createdAt: number
  completedAt?: number
  /** 瞬时速度 bytes/s */
  speed: number
  /** 预估剩余秒数 */
  timeLeft: number
  retryCount: number
  errorMessage?: string
  contentType?: string
}

/** 引擎全局统计 */
export interface EngineStats {
  activeCount: number
  totalSpeed: number
  totalDownloadedBytes: number
  taskCountByStatus: Record<TaskStatus, number>
}

/** 应用配置项 */
export interface AppSettings {
  downloadDir: string
  connections: number
  maxActiveTasks: number
  globalSpeedLimit: number // bytes/s，0 表示不限速
  taskSpeedLimit: number
  userAgent: string
  maxRetries: number
  requestTimeout: number
  insecureTLS: boolean
  autoStartNext: boolean
  /** 关闭主窗口时最小化到托盘 */
  minimizeToTray: boolean
  proxy: ProxyConfig
  browser: BrowserIntegration
}

/** 浏览器接管相关配置 */
export interface BrowserIntegration {
  /** 是否启用本地通信服务 */
  enabled: boolean
  /** 监听端口，占用时自动顺延 */
  port: number
  /** 自动接管浏览器下载（拦截并交给 FluxGet） */
  interceptDownloads: boolean
  /** 监视剪贴板中的下载链接 */
  watchClipboard: boolean
  /** 接管下载时显示通知 */
  notifyOnIntercept: boolean
}

/** 本地桥接服务运行状态 */
export interface BridgeStatus {
  running: boolean
  port: number
  version: string
  /** 是否需要 token（始终为 true，仅作协议说明） */
  secure: boolean
}

export interface ProxyConfig {
  enabled: boolean
  type: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username?: string
  password?: string
}

export type TaskCategory = 'all' | 'downloading' | 'completed' | 'paused' | 'failed'

/** 渲染进程调用主进程的 API 契约（挂在 window.api 上） */
export interface FluxGetAPI {
  createTask: (payload: CreateTaskPayload) => Promise<{ ok: boolean; id?: string; error?: string }>
  batchCreateTasks: (urls: string[]) => Promise<{ ok: boolean; ids?: string[]; error?: string }>
  pauseTask: (id: string) => Promise<void>
  resumeTask: (id: string) => Promise<void>
  cancelTask: (id: string, deleteFile: boolean) => Promise<void>
  redoTask: (id: string) => Promise<void>
  getTasks: () => Promise<TaskSnapshot[]>
  getSettings: () => Promise<AppSettings>
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  selectDirectory: () => Promise<string | undefined>
  openPath: (targetPath: string) => Promise<void>
  showInFolder: (targetPath: string) => Promise<void>
  probeUrl: (url: string) => Promise<ProbeResult>
  clearFinished: () => Promise<void>
  getAppVersion: () => Promise<string>
  getBridgeStatus: () => Promise<BridgeStatus>
  /** 打开浏览器扩展管理页（Chrome / Edge） */
  openExtensionsPage: () => Promise<void>
  /** 打开系统 web 地址 */
  openExternal: (url: string) => Promise<void>
  /** 读取剪贴板文本 */
  readClipboard: () => Promise<string>
  /** 订阅主进程推送的事件 */
  onTaskUpdate: (cb: (tasks: TaskSnapshot[]) => void) => void
  onStats: (cb: (stats: EngineStats) => void) => void
  onNotification: (cb: (payload: { title: string; body: string }) => void) => void
  /** 剪贴板监视检测到下载链接 */
  onClipboardLinks: (cb: (links: string[]) => void) => void
  /** 菜单或快捷键请求打开设置（macOS Cmd+,） */
  onOpenSettings: (cb: () => void) => void
  /** 托盘菜单请求新建任务 */
  onNewTask: (cb: () => void) => void
}

export interface CreateTaskPayload {
  url: string
  dirPath?: string
  fileName?: string
  connections?: number
  /** 来源页，用于突破防盗链 */
  referrer?: string
}

export interface ProbeResult {
  ok: boolean
  fileName?: string
  totalSize?: number
  supportsRange?: boolean
  contentType?: string
  error?: string
}
