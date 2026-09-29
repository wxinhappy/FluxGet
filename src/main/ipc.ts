import { app, clipboard, dialog, ipcMain, shell, BrowserWindow, Notification } from 'electron'
import type { DownloadEngine } from '@main/engine/DownloadEngine'
import type { AppSettings, CreateTaskPayload } from '@shared/types'

export interface IpcContext {
  engine: DownloadEngine
  getMainWindow: () => BrowserWindow | null
  getSettings: () => AppSettings
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  broadcast: (channel: string, payload: unknown) => void
  getBridgeStatus: () => { running: boolean; port: number; version: string; secure: boolean }
  /** 供剪贴板监视更新基准值，避免重复提示 */
  syncClipboardBaseline: () => void
}

/** 注册所有主进程 IPC 处理函数 */
export function registerIpc(ctx: IpcContext): void {
  const { engine, getMainWindow, getSettings, updateSettings, broadcast } = ctx

  ipcMain.handle('task:create', async (_e, payload: CreateTaskPayload) => {
    return engine.createTask(payload)
  })

  ipcMain.handle('task:batchCreate', async (_e, urls: string[]) => {
    return engine.batchCreateTasks(urls)
  })

  ipcMain.handle('task:pause', async (_e, id: string) => {
    await engine.pauseTask(id)
    broadcast('tasks:update', engine.getSnapshots())
  })

  ipcMain.handle('task:resume', async (_e, id: string) => {
    await engine.resumeTask(id)
    broadcast('tasks:update', engine.getSnapshots())
  })

  ipcMain.handle('task:cancel', async (_e, id: string, deleteFile: boolean) => {
    await engine.cancelTask(id, deleteFile)
    broadcast('tasks:update', engine.getSnapshots())
  })

  ipcMain.handle('task:redo', async (_e, id: string) => {
    await engine.redoTask(id)
    broadcast('tasks:update', engine.getSnapshots())
  })

  ipcMain.handle('task:list', async () => {
    return engine.getSnapshots()
  })

  ipcMain.handle('task:clearFinished', async () => {
    engine.clearFinished()
    broadcast('tasks:update', engine.getSnapshots())
  })

  ipcMain.handle('task:setConnections', async (_e, id: string, n: number) => {
    engine.setTaskConnections(id, n)
  })

  ipcMain.handle('probe', async (_e, url: string) => {
    return engine.probe(url)
  })

  ipcMain.handle('settings:get', async () => getSettings())

  ipcMain.handle('settings:save', async (_e, patch: Partial<AppSettings>) => {
    const next = await updateSettings(patch)
    engine.applySettings(next)
    broadcast('settings:update', next)
    return next
  })

  ipcMain.handle('dialog:selectDirectory', async (_e, defaultPath?: string) => {
    const win = getMainWindow()
    if (!win) return undefined
    const res = await dialog.showOpenDialog(win, {
      defaultPath: defaultPath ?? getSettings().downloadDir,
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return undefined
    return res.filePaths[0]
  })

  ipcMain.handle('shell:openPath', async (_e, target: string) => {
    await shell.openPath(target)
  })

  ipcMain.handle('shell:showItemInFolder', async (_e, target: string) => {
    shell.showItemInFolder(target)
  })

  ipcMain.handle('app:version', async () => app.getVersion())

  ipcMain.handle('bridge:status', async () => ctx.getBridgeStatus())

  ipcMain.handle('clipboard:read', async () => {
    try {
      ctx.syncClipboardBaseline()
      return clipboard.readText()
    } catch {
      return ''
    }
  })

  ipcMain.handle('clipboard:syncBaseline', async () => {
    ctx.syncClipboardBaseline()
  })

  /** 打开 Chrome / Edge 扩展管理页 */
  ipcMain.handle('browser:openExtensionsPage', async (_e, channel?: string) => {
    const target = channel === 'edge' ? 'edge://extensions' : 'chrome://extensions'
    await shell.openExternal(target)
  })

  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
      await shell.openExternal(url)
    }
  })

  /** 渲染进程请求系统通知 */
  ipcMain.handle('app:notify', async (_e, payload: { title: string; body: string }) => {
    if (Notification.isSupported()) {
      new Notification({ title: payload.title, body: payload.body }).show()
    }
  })
}
