import { clipboard } from 'electron'

const LINK_PATTERN = /https?:\/\/[^\s"'<>)]+/gi
/** 常见媒体与压缩包后缀，用于过滤剪贴板里的无效链接 */
const DOWNLOAD_LIKE =
  /\.(mp4|mkv|avi|mov|m4v|flv|webm|ts|mp3|m4a|flac|wav|aac|zip|rar|7z|tar|gz|iso|msi|exe|dmg|apk|pdf|epub|docx?|xlsx?|pptx?|apk)(\?|#|$)/i

export interface ClipboardWatcherOptions {
  intervalMs?: number
  onLinks: (links: string[]) => void
}

/**
 * 剪贴板监视（IDM 同款辅助能力）
 * 轮询检测剪贴板中出现的下载地址，交由上层决定是否提示新建任务。
 */
export class ClipboardWatcher {
  private timer: NodeJS.Timeout | null = null
  private lastText = ''
  private started = false

  constructor(private readonly options: ClipboardWatcherOptions) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.lastText = this.read()
    this.timer = setInterval(() => {
      const current = this.read()
      if (current && current !== this.lastText) {
        this.lastText = current
        const links = extractDownloadLinks(current)
        if (links.length > 0) this.options.onLinks(links)
      }
    }, this.options.intervalMs ?? 1200)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.started = false
  }

  get running(): boolean {
    return this.started
  }

  /** 读取当前剪贴板文本 */
  read(): string {
    try {
      return clipboard.readText()
    } catch {
      return ''
    }
  }
}

/** 从任意文本中提取可下载链接 */
export function extractDownloadLinks(text: string): string[] {
  const matches = text.match(LINK_PATTERN)
  if (!matches) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of matches) {
    const link = raw.trim()
    if (seen.has(link)) continue
    seen.add(link)
    out.push(link)
  }
  return out
}

/** 判断链接是否像下载资源 */
export function looksLikeDownload(url: string): boolean {
  return DOWNLOAD_LIKE.test(url)
}
