import path from 'node:path'
import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { DownloadEngine } from '@main/engine/DownloadEngine'
import type { TaskRecord } from '@main/engine/DownloadEngine'
import { defaultSettings, mergeSettings } from '@main/store/Settings'
import { ensureDir, readJsonFile, writeJsonFileAtomic } from '@main/store/Persistence'
import { HttpBridge } from '@main/bridge/HttpBridge'
import { ClipboardWatcher } from '@main/bridge/ClipboardWatcher'
import { registerIpc } from '@main/ipc'
import type { AppSettings, EngineStats, TaskSnapshot } from '@shared/types'

/** macOS 平台判定：窗口关闭行为、菜单栏、托盘与 Dock 均为平台专属逻辑 */
export const isMac = process.platform === 'darwin'

/**
 * 解析运行时资源路径
 * 打包后资源随 extraResources 落在 resources/assets，开发期直接读项目 build 目录
 */
function assetPath(name: string): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'assets', name)
  return path.join(app.getAppPath(), 'build', name)
}

/**
 * 应用菜单栏（仅 macOS 需要）
 * Windows 隐藏菜单栏，不构建自定义模板以免遮挡界面
 */
function setupApplicationMenu(): void {
  if (!isMac) return

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: '设置…',
          accelerator: 'Cmd+,',
          click: () => {
            mainWindow?.show()
            mainWindow?.focus()
            mainWindow?.webContents.send('app:openSettings')
          }
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * 系统托盘
 * macOS 使用模板图标（黑白 mask），由系统按明暗模式自动着色；
 * Windows 使用彩色图标。
 */
function setupTray(): void {
  try {
    const iconFile = isMac ? 'trayTemplate.png' : 'tray.png'
    const image = nativeImage.createFromPath(assetPath(iconFile))
    if (image.isEmpty()) {
      console.warn('[FluxGet] 托盘图标未找到，已跳过托盘初始化')
      return
    }
    if (isMac) image.setTemplateImage(true)

    tray = new Tray(image)
    tray.setToolTip('FluxGet 下载管理器')

    const menu = Menu.buildFromTemplate([
      {
        label: '新建下载任务',
        click: () => {
          mainWindow?.show()
          mainWindow?.focus()
          mainWindow?.webContents.send('app:newTask')
        }
      },
      {
        label: '打开主窗口',
        click: () => {
          mainWindow?.show()
          mainWindow?.focus()
        }
      },
      { type: 'separator' },
      {
        label: '打开下载目录',
        click: () => {
          void shell.openPath(settings.downloadDir)
        }
      },
      { type: 'separator' },
      {
        label: '退出 FluxGet',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])

    tray.setContextMenu(menu)
    // macOS 单击托盘图标唤出窗口，Windows 点击托盘按钮唤出窗口
    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) mainWindow.focus()
        else mainWindow.show()
      }
    })
  } catch (err) {
    console.warn('[FluxGet] 托盘初始化失败:', err instanceof Error ? err.message : err)
  }
}

/** 在 Dock 图标上显示进行中的任务数（仅 macOS） */
function updateDockBadge(activeCount: number): void {
  if (!isMac || !app.dock) return
  app.dock.setBadge(activeCount > 0 ? String(activeCount) : '')
}
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let settings: AppSettings = defaultSettings()
let engine: DownloadEngine | null = null
let bridge: HttpBridge | null = null
let clipboardWatcher: ClipboardWatcher | null = null
let tasksFile = ''
let settingsFile = ''

let persistTimer: NodeJS.Timeout | null = null
let pendingRecords: TaskRecord[] = []

/** 单实例运行，避免重复启动导致任务冲突 */
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    void bootstrap()
  })
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData')
  await ensureDir(userData)

  settingsFile = path.join(userData, 'settings.json')
  tasksFile = path.join(userData, 'tasks.json')

  const storedSettings = await readJsonFile<Partial<AppSettings>>(settingsFile, {})
  settings = mergeSettings(storedSettings)
  await ensureDir(settings.downloadDir)

  const records = await readJsonFile<TaskRecord[]>(tasksFile, [])

  // 用局部常量持有实例，避免闭包里对模块级可空变量做判空
  const engineInstance = new DownloadEngine({
    getSettings: () => settings,
    onUpdate: (tasks, stats) => {
      broadcast(tasks, stats)
    },
    onNotify: (payload) => {
      if (Notification.isSupported()) {
        new Notification({ title: payload.title, body: payload.body }).show()
      }
    },
    onPersist: (recs) => schedulePersist(recs)
  })
  engine = engineInstance

  engineInstance.loadRecords(records)
  engineInstance.applySettings(settings)
  engineInstance.start()

  // ---- 本地通信桥接（浏览器扩展） ----
  bridge = new HttpBridge({
    createTasks: async (payload) => engineInstance.batchCreateTasks(payload.urls, payload),
    createSingle: async (payload) => engineInstance.createSingle(payload),
    listTasks: () => engineInstance.getSnapshots(),
    getVersion: () => app.getVersion(),
    notify: (payload) => {
      if (Notification.isSupported()) new Notification({ title: payload.title, body: payload.body }).show()
    }
  })

  if (settings.browser.enabled) {
    try {
      const port = await bridge.start(settings.browser.port)
      console.log('[FluxGet] 浏览器扩展桥接已启动，端口 ' + port)
    } catch (err) {
      console.warn('[FluxGet] 桥接服务启动失败:', err instanceof Error ? err.message : err)
    }
  }

  // ---- 剪贴板监视 ----
  clipboardWatcher = new ClipboardWatcher({
    onLinks: (links) => {
      mainWindow?.webContents.send('clipboard:links', links)
    }
  })
  if (settings.browser.watchClipboard) clipboardWatcher.start()

  registerIpc({
    engine: engineInstance,
    getMainWindow: () => mainWindow,
    getSettings: () => settings,
    updateSettings: async (patch) => {
      const before = settings.browser
      settings = mergeSettings(patch, settings)
      await writeJsonFileAtomic(settingsFile, settings)
      if (settings.downloadDir) await ensureDir(settings.downloadDir)
      await applyBrowserSettings(before)
      return settings
    },
    broadcast: (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload)
      }
    },
    getBridgeStatus: () => ({
      running: bridge?.running ?? false,
      port: bridge?.port ?? settings.browser.port,
      version: app.getVersion(),
      secure: true
    }),
    syncClipboardBaseline: () => {
      clipboardWatcher?.read()
    }
  })

  setupApplicationMenu()
  setupTray()

  createWindow()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    title: 'FluxGet 下载管理器',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  // macOS 惯例：点红叉只是收起窗口，应用继续在 Dock 中运行；Cmd+Q 才真正退出
  mainWindow.on('close', (event) => {
    if (isMac && !isQuitting && settings.minimizeToTray) {
      event.preventDefault()
      mainWindow?.hide()
      if (app.dock) app.dock.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.on('show', () => {
    if (isMac && app.dock) app.dock.show()
  })

  // 外部链接交给系统浏览器处理
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function broadcast(tasks: TaskSnapshot[], stats: EngineStats): void {
  updateDockBadge(stats.activeCount)
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('tasks:update', tasks)
  mainWindow.webContents.send('stats:update', stats)
}

/**
 * 浏览器集成配置的运行时联动：
 * 开关变化时启停桥接服务，剪贴板监视单独控制。
 */
async function applyBrowserSettings(before?: AppSettings['browser']): Promise<void> {
  const next = settings.browser
  const prev = before ?? next

  if (bridge) {
    if (next.enabled && !bridge.running) {
      try {
        await bridge.start(next.port)
      } catch (err) {
        console.warn('[FluxGet] 桥接启动失败:', err instanceof Error ? err.message : err)
      }
    } else if (!next.enabled && bridge.running) {
      bridge.stop()
    } else if (next.enabled && bridge.running && next.port !== prev.port) {
      try {
        await bridge.restart(next.port)
      } catch (err) {
        console.warn('[FluxGet] 桥接重启失败:', err instanceof Error ? err.message : err)
      }
    }
  }

  if (clipboardWatcher) {
    if (next.watchClipboard && !clipboardWatcher.running) clipboardWatcher.start()
    else if (!next.watchClipboard && clipboardWatcher.running) clipboardWatcher.stop()
  }
}

/** 断点信息写盘节流，避免高频 IO */
function schedulePersist(records: TaskRecord[]): void {
  pendingRecords = records
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    const snapshot = pendingRecords
    if (tasksFile) {
      writeJsonFileAtomic(tasksFile, snapshot).catch(() => undefined)
    }
  }, 1500)
}

app.on('window-all-closed', () => {
  // 关闭窗口即退出（Windows / Linux 惯例）；macOS 由 Dock 常驻，走 activate 复活
  if (!isMac) app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  clipboardWatcher?.stop()
  bridge?.stop()
  void (async () => {
    await engine?.shutdown()
  })()
})

app.on('activate', () => {
  // macOS：点击 Dock 图标重新唤出窗口
  const windows = BrowserWindow.getAllWindows()
  if (windows.length === 0) {
    createWindow()
    return
  }
  const win = windows[0]
  if (!win.isVisible()) win.show()
  win.focus()
})
