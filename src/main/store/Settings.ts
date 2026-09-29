import os from 'node:os'
import path from 'node:path'
import type { AppSettings } from '@shared/types'
import {
  DEFAULT_CONNECTIONS,
  DEFAULT_MAX_ACTIVE_TASKS,
  DEFAULT_USER_AGENT
} from '@shared/constants'

/** 默认下载目录 */
export function defaultDownloadDir(): string {
  return path.join(os.homedir(), 'Downloads', 'FluxGet')
}

/** 浏览器接管默认端口 */
export const DEFAULT_BRIDGE_PORT = 16888

export function defaultSettings(): AppSettings {
  return {
    downloadDir: defaultDownloadDir(),
    connections: DEFAULT_CONNECTIONS,
    maxActiveTasks: DEFAULT_MAX_ACTIVE_TASKS,
    globalSpeedLimit: 0,
    taskSpeedLimit: 0,
    userAgent: DEFAULT_USER_AGENT,
    maxRetries: 6,
    requestTimeout: 30000,
    insecureTLS: false,
    autoStartNext: true,
    minimizeToTray: true,
    proxy: {
      enabled: false,
      type: 'http',
      host: '',
      port: 7890,
      username: '',
      password: ''
    },
    browser: {
      enabled: true,
      port: DEFAULT_BRIDGE_PORT,
      interceptDownloads: true,
      watchClipboard: false,
      notifyOnIntercept: true
    }
  }
}

/** 合并用户配置，补齐缺失字段，防止旧版本配置升级后缺 key */
export function mergeSettings(patch: Partial<AppSettings>, base?: AppSettings): AppSettings {
  const prev = base ?? defaultSettings()
  return {
    ...prev,
    ...patch,
    proxy: { ...prev.proxy, ...(patch.proxy ?? {}) },
    browser: { ...prev.browser, ...(patch.browser ?? {}) }
  }
}
