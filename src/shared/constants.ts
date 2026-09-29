/** FluxGet 引擎调参 */
export const DEFAULT_CONNECTIONS = 8
export const MAX_CONNECTIONS = 32
export const MIN_CONNECTIONS = 1

/** 单个分片的最小粒度：文件太小不值得拆 */
export const MIN_CHUNK_SIZE = 256 * 1024

/** 动态分裂触发阈值：某分片剩余量超过该值时才允许被分裂 */
export const MIN_SPLIT_REMAIN = 1024 * 1024

/** 动态分裂检查周期 */
export const SPLIT_CHECK_INTERVAL = 800

export const DEFAULT_MAX_ACTIVE_TASKS = 3

/** socket 静默超时（毫秒），超时后重试该分片 */
export const SOCKET_TIMEOUT = 30_000
export const CONNECT_TIMEOUT = 15_000

export const MAX_REDIRECTS = 8
export const MAX_RETRIES = 6
export const RETRY_BASE_DELAY = 800
export const RETRY_MAX_DELAY = 15_000

/** 速度采样窗口 */
export const SPEED_WINDOW_MS = 3000

/** 进度广播间隔 */
export const BROADCAST_INTERVAL = 500

/** 断点状态落盘节流间隔 */
export const PERSIST_INTERVAL = 2000

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 FluxGet/1.0'
