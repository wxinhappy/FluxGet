import { contextBridge, ipcRenderer } from 'electron'
import type { FluxGetAPI } from '@shared/types'

/** 通过 contextBridge 向渲染进程暴露受控 API */
const api: FluxGetAPI = {
  createTask: (payload) => ipcRenderer.invoke('task:create', payload),
  batchCreateTasks: (urls) => ipcRenderer.invoke('task:batchCreate', urls),
  pauseTask: (id) => ipcRenderer.invoke('task:pause', id),
  resumeTask: (id) => ipcRenderer.invoke('task:resume', id),
  cancelTask: (id, deleteFile) => ipcRenderer.invoke('task:cancel', id, deleteFile),
  redoTask: (id) => ipcRenderer.invoke('task:redo', id),
  getTasks: () => ipcRenderer.invoke('task:list'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  openPath: (target) => ipcRenderer.invoke('shell:openPath', target),
  showInFolder: (target) => ipcRenderer.invoke('shell:showItemInFolder', target),
  probeUrl: (url) => ipcRenderer.invoke('probe', url),
  clearFinished: () => ipcRenderer.invoke('task:clearFinished'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getBridgeStatus: () => ipcRenderer.invoke('bridge:status'),
  openExtensionsPage: () => ipcRenderer.invoke('browser:openExtensionsPage'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),

  onTaskUpdate: (cb) => {
    const listener = (_e: unknown, tasks: unknown): void => {
      cb(tasks as Parameters<typeof cb>[0])
    }
    ipcRenderer.on('tasks:update', listener)
  },
  onStats: (cb) => {
    const listener = (_e: unknown, stats: unknown): void => {
      cb(stats as Parameters<typeof cb>[0])
    }
    ipcRenderer.on('stats:update', listener)
  },
  onNotification: (cb) => {
    const listener = (_e: unknown, payload: unknown): void => {
      cb(payload as Parameters<typeof cb>[0])
    }
    ipcRenderer.on('app:notify', listener)
  },
  onClipboardLinks: (cb) => {
    const listener = (_e: unknown, links: unknown): void => {
      cb(links as string[])
    }
    ipcRenderer.on('clipboard:links', listener)
  },
  onOpenSettings: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('app:openSettings', listener)
  },
  onNewTask: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('app:newTask', listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('fluxget', api)
  } catch (error) {
    console.error('[FluxGet] preload 注入失败:', error)
  }
} else {
  // 极端情况下 contextIsolation 未生效时的兜底
  ;(window as unknown as Record<string, unknown>)['fluxget'] = api
}

declare global {
  interface Window {
    fluxget: FluxGetAPI
  }
}
