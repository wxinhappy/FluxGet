const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

function toHuman(bytes: number, perSecond = false): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return perSecond ? '0 B/s' : '0 B'
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  const fixed = value >= 100 || i === 0 ? 0 : 1
  const suffix = perSecond ? `${UNITS[i]}/s` : UNITS[i]
  return `${value.toFixed(fixed)} ${suffix}`
}

/** 文件体积格式化 */
export function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || bytes < 0) return '--'
  return toHuman(bytes, false)
}

/** 下载速度格式化 */
export function formatSpeed(bytesPerSecond?: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '0 B/s'
  return toHuman(bytesPerSecond, true)
}

/** 秒数转成可读时长 */
export function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds < 0) return '--'
  const total = Math.round(seconds)
  if (total < 60) return `${total} 秒`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分`
  const h = Math.floor(m / 60)
  const mm = m % 60
  if (h < 24) return mm > 0 ? `${h} 时 ${mm} 分` : `${h} 时`
  const d = Math.floor(h / 24)
  return `${d} 天 ${h % 24} 时`
}

/** 百分比 */
export function formatPercent(done: number, total: number): number {
  if (!total || total <= 0) return 0
  return Math.min(100, Math.max(0, (done / total) * 100))
}

/** 时间戳 */
export function formatTime(ts?: number): string {
  if (!ts) return '--'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
