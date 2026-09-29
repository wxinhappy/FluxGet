import { useCallback, useEffect, useMemo, useState } from 'react'
import Sidebar from './components/Sidebar'
import Toolbar from './components/Toolbar'
import TaskList from './components/TaskList'
import StatusBar from './components/StatusBar'
import NewTaskDialog from './components/NewTaskDialog'
import SettingsDialog from './components/SettingsDialog'
import { useDownloadData } from './hooks/useDownloadData'
import type { AppSettings, CreateTaskPayload, TaskCategory, TaskSnapshot } from '@shared/types'

export default function App(): JSX.Element {
  const { tasks, stats } = useDownloadData()
  const [category, setCategory] = useState<TaskCategory>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [clipboardLink, setClipboardLink] = useState<string | undefined>(undefined)

  useEffect(() => {
    window.fluxget.getSettings().then(setSettings).catch(() => undefined)
  }, [])

  // 剪贴板监视：检测到下载链接时直接弹出新建任务窗口
  useEffect(() => {
    window.fluxget.onClipboardLinks((links) => {
      if (links.length === 0) return
      setClipboardLink(links[0])
      setNewTaskOpen(true)
    })
  }, [])

  // macOS 菜单「设置…」或 Cmd+,
  useEffect(() => {
    window.fluxget.onOpenSettings(() => setSettingsOpen(true))
  }, [])

  // 托盘菜单「新建下载任务」
  useEffect(() => {
    window.fluxget.onNewTask(() => setNewTaskOpen(true))
  }, [])

  const notify = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 2800)
  }, [])

  const filtered = useMemo(() => {
    switch (category) {
      case 'downloading':
        return tasks.filter((t) => t.status === 'downloading' || t.status === 'pending')
      case 'completed':
        return tasks.filter((t) => t.status === 'completed')
      case 'paused':
        return tasks.filter((t) => t.status === 'paused')
      case 'failed':
        return tasks.filter((t) => t.status === 'failed')
      default:
        return tasks
    }
  }, [tasks, category])

  const selected = useMemo<TaskSnapshot | null>(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId]
  )

  const handleCreate = useCallback(
    async (payload: CreateTaskPayload | { urls: string[] }) => {
      if ('urls' in payload) {
        const r = await window.fluxget.batchCreateTasks(payload.urls)
        if (r.ok) notify(`已创建 ${r.ids?.length ?? 0} 个任务`)
        else notify(`创建失败：${r.error ?? '未知错误'}`)
      } else {
        const r = await window.fluxget.createTask(payload)
        if (r.ok) notify('任务已加入队列')
        else notify(`创建失败：${r.error ?? '未知错误'}`)
      }
      setCategory('downloading')
    },
    [notify]
  )

  const handlePause = useCallback(async () => {
    if (!selected) return
    await window.fluxget.pauseTask(selected.id)
  }, [selected])

  const handleResume = useCallback(async () => {
    if (!selected) return
    await window.fluxget.resumeTask(selected.id)
  }, [selected])

  const handleRedo = useCallback(async () => {
    if (!selected) return
    await window.fluxget.redoTask(selected.id)
    notify('已重新下载')
  }, [selected, notify])

  const handleDelete = useCallback(
    async (deleteFile: boolean) => {
      if (!selected) return
      await window.fluxget.cancelTask(selected.id, deleteFile)
      setSelectedId(null)
      notify(deleteFile ? '任务已删除，文件已移除' : '任务已从列表移除')
    },
    [selected, notify]
  )

  const handleClearFinished = useCallback(async () => {
    await window.fluxget.clearFinished()
    notify('已清理完成的任务记录')
  }, [notify])

  const handleSaveSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const next = await window.fluxget.saveSettings(patch)
      setSettings(next)
      notify('设置已保存')
    },
    [notify]
  )

  // 全局快捷键
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setNewTaskOpen(true)
        return
      }
      if (e.key === 'F1') {
        e.preventDefault()
        setSettingsOpen((v) => !v)
        return
      }
      if (e.key === 'Delete' && selected) {
        e.preventDefault()
        void window.fluxget.cancelTask(selected.id, false)
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selected])

  return (
    <div className="app-shell">
      <Sidebar
        category={category}
        onChange={setCategory}
        counts={{
          all: tasks.length,
          downloading: tasks.filter((t) => t.status === 'downloading' || t.status === 'pending').length,
          completed: tasks.filter((t) => t.status === 'completed').length,
          paused: tasks.filter((t) => t.status === 'paused').length,
          failed: tasks.filter((t) => t.status === 'failed').length
        }}
      />

      <div className="app-main">
        <Toolbar
          hasSelection={!!selected}
          selectedStatus={selected?.status}
          onNewTask={() => setNewTaskOpen(true)}
          onPause={handlePause}
          onResume={handleResume}
          onRedo={handleRedo}
          onDelete={handleDelete}
          onClearFinished={handleClearFinished}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <TaskList
          tasks={filtered}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onPause={async (id) => window.fluxget.pauseTask(id)}
          onResume={async (id) => window.fluxget.resumeTask(id)}
          onRedo={handleRedo}
          onDelete={handleDelete}
          onOpenFile={async (p) => window.fluxget.openPath(p)}
          onShowInFolder={async (p) => window.fluxget.showInFolder(p)}
        />

        <StatusBar stats={stats} downloadDir={settings?.downloadDir} />
      </div>

      {newTaskOpen && settings && (
        <NewTaskDialog
          settings={settings}
          initialUrl={clipboardLink}
          onClose={() => {
            setNewTaskOpen(false)
            setClipboardLink(undefined)
          }}
          onSubmit={handleCreate}
        />
      )}

      {settingsOpen && settings && (
        <SettingsDialog
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSave={handleSaveSettings}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
