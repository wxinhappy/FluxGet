import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 分片文件写入器
 *
 * 采用「预分配 + 随机位置定向写入」模型：
 *   1. 任务开始前把文件 truncate 到目标大小，各连接并行写各自区间，无需事后合并。
 *   2. 断点续传时沿用 'r+' 模式打开已有文件，跳过重头写可能造成的数据错乱。
 */
export class ChunkedFileWriter {
  private handle: fsp.FileHandle | null = null
  private allocated = false

  constructor(
    private readonly filePath: string,
    private readonly totalSize: number
  ) {}

  /**
   * 打开（必要时创建）目标文件并预分配空间。
   * @param mode 'resume' 保留已有内容用于续传；'create' 强制重建（重下 / 资源变化）
   */
  async open(mode: 'resume' | 'create' = 'resume'): Promise<void> {
    await fsp.mkdir(dirname(this.filePath), { recursive: true })

    if (mode === 'create' || !(await exists(this.filePath))) {
      await fsp.rm(this.filePath, { force: true })
      const h = await fsp.open(this.filePath, 'w')
      await h.close()
    }

    this.handle = await fsp.open(this.filePath, 'r+')
    if (this.totalSize > 0) {
      const stat = await this.handle.stat()
      if (stat.size < this.totalSize) {
        await this.handle.truncate(this.totalSize)
      }
      this.allocated = true
    }
  }

  /** 把数据写到文件的绝对偏移位置 */
  async writeAt(position: number, buffer: Buffer): Promise<void> {
    if (!this.handle) throw new Error('文件句柄未打开')
    const { bytesWritten } = await this.handle.write(buffer, 0, buffer.length, position)
    if (bytesWritten !== buffer.length) {
      throw new Error(`写入不完整：期望 ${buffer.length} 字节，实际 ${bytesWritten} 字节`)
    }
  }

  /**
   * 把某一区间的数据刷盘。
   * 长时间运行的大文件定期调用，确保异常退出时已下载数据不丢失。
   */
  async flush(): Promise<void> {
    if (this.handle) await this.handle.sync()
  }

  /** 完成后修正文件真实长度（防止探测的长度有误导致尾部多余空洞） */
  async finalize(expectedSize: number): Promise<void> {
    if (!this.handle) return
    try {
      const stat = await this.handle.stat()
      if (stat.size !== expectedSize) {
        await this.handle.truncate(expectedSize)
      }
    } catch {
      /* 忽略 finalize 阶段的异常，不应影响任务完成判定 */
    }
  }

  async close(): Promise<void> {
    if (this.handle) {
      try {
        await this.handle.close()
      } catch {
        /* 忽略重复关闭 */
      }
      this.handle = null
    }
  }

  get isAllocated(): boolean {
    return this.allocated
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}
