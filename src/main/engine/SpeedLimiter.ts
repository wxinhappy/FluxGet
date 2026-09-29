/**
 * 令牌桶限速器
 * 用于全局限速与单任务限速。limitBps <= 0 表示不限速（零开销直通）。
 */
export class SpeedLimiter {
  private limitBps: number
  private tokens: number
  private lastRefillAt: number

  constructor(limitBps = 0) {
    this.limitBps = limitBps > 0 ? limitBps : 0
    // 初始令牌为 0：避免刚创建时凭空获得一整秒配额，造成起步突发
    this.tokens = 0
    this.lastRefillAt = Date.now()
  }

  get limit(): number {
    return this.limitBps
  }

  setLimit(bytesPerSecond: number): void {
    const next = bytesPerSecond > 0 ? bytesPerSecond : 0
    this.refill()
    this.limitBps = next
    // 令牌桶容量按 250ms 的窗口算，避免长窗口积累过多令牌造成瞬时突发
    const cap = Math.max(next * 0.25, next)
    this.tokens = Math.min(this.tokens, cap)
  }

  private refill(): void {
    if (this.limitBps <= 0) return
    const now = Date.now()
    const elapsedSec = (now - this.lastRefillAt) / 1000
    if (elapsedSec <= 0) return
    this.lastRefillAt = now
    const cap = this.limitBps
    this.tokens = Math.min(cap, this.tokens + this.limitBps * elapsedSec)
  }

  /**
   * 消费 n 字节配额，令牌不足时阻塞等待。
   * 按 data 事件粒度调用即可获得平滑的平均速率。
   */
  async consume(n: number): Promise<void> {
    if (this.limitBps <= 0) return
    let need = n
    // 单次需要的令牌超过桶容量时分批等待，避免长时间无响应阻塞
    while (need > 0) {
      this.refill()
      const available = this.tokens
      if (available >= need) {
        this.tokens -= need
        return
      }
      const deficit = need - available
      const waitMs = Math.max(1, Math.ceil((deficit / this.limitBps) * 1000))
      await sleep(Math.min(waitMs, 1000))
      this.refill()
      const got = Math.min(need, this.tokens)
      this.tokens -= got
      need -= got
    }
  }

  reset(): void {
    this.tokens = this.limitBps
    this.lastRefillAt = Date.now()
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
