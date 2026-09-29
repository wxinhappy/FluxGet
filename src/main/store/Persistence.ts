import { promises as fsp } from 'node:fs'
import path from 'node:path'

/** 确保目录存在 */
export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
}

/** 读取 JSON 文件，缺失或解析失败时返回兜底值 */
export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    if (raw.length === 0) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/**
 * 原子写入：先写临时文件再 rename，避免进程被强杀时留下半截配置。
 */
export async function writeJsonFileAtomic<T>(file: string, data: T): Promise<void> {
  const dir = path.dirname(file)
  await ensureDir(dir)
  const tmp = file + '.tmp'
  const payload = JSON.stringify(data)
  await fsp.writeFile(tmp, payload, 'utf8')
  try {
    await fsp.rename(tmp, file)
  } catch (err) {
    // Windows 下偶发占用，退化为直接写目标文件
    await fsp.writeFile(file, payload, 'utf8')
    await fsp.rm(tmp, { force: true })
    void err
  }
}
