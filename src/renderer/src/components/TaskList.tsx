import { useEffect, useRef, useState } from 'react'
import type { TaskSnapshot, TaskStatus } from '@shared/types'
import ChunkMap from './ChunkMap'
import { formatBytes, formatDuration, formatPercent, formatSpeed } from '../utils/format'

export interface TaskListProps {
  tasks: TaskSnapshot[]
  selectedId: string | null
  onSelect: (id: string) => void
  onPause: (id: string) => Promise<void>
  onResume: (id: string) => Promise<void>
  onRedo: () => void
  onDelete: (deleteFile: boolean) => void
  onOpenFile: (p: string) => Promise<void>
  onShowInFolder: (p: string) => Promise<void>
}

const STATUS_TEXT: Record<TaskStatus, string> = {
  pending: '等待中',
  probing: '解析中',
  downloading: '下载中',
  paused: '已暂停',
  completed: '已完成',
  failed: '已失败',
  canceled: '已取消'
}

interface MenuState {
  x: number
  y: number
  task: TaskSnapshot
}

export default function TaskList({
  tasks,
  selectedId,
  onSelect,
  onPause,
  onResume,
  onRedo,
  onDelete,
  onOpenFile,
  onShowInFolder
}: TaskListProps): JSX.Element {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [])

  const openMenu = (e: React.MouseEvent, task: TaskSnapshot): void => {
    e.preventDefault()
    onSelect(task.id)
    setMenu({ x: e.clientX, y: e.clientY, task })
  }

  const copyUrl = async (url: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      /* 剪贴板不可用时忽略 */
    }
    setMenu(null)
  }

  return (
    <div className="task-list-wrap">
      <div className="list-head">
        <span>文件名</span>
        <span>大小</span>
        <span>进度</span>
        <span>速度</span>
        <span>剩余时间</span>
        <span>状态</span>
      </div>

      <div className="list-body">
        {tasks.length === 0 && (
          <div className="empty">
            <div className="empty-icon">
              <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v12" />
                <path d="M7 11l5 5 5-5" />
                <path d="M5 21h14" />
              </svg>
            </div>
            <p>还没有下载任务</p>
            <small>点击左上角「新建任务」或按 Ctrl + N 开始</small>
          </div>
        )}

        {tasks.map((t) => {
          const pct = formatPercent(t.downloadedSize, t.totalSize)
          const active = t.status === 'downloading'
          return (
            <div
              key={t.id}
              className={'task-row' + (selectedId === t.id ? ' selected' : '')}
              onClick={() => onSelect(t.id)}
              onDoubleClick={() => void onOpenFile(t.savePath)}
              onContextMenu={(e) => openMenu(e, t)}
            >
              <div className="col name">
                <span className="file-name" title={t.fileName}>
                  {t.fileName}
                </span>
                <span className="sub">
                  {t.supportsRange ? `${t.connections} 连接 · 支持断点` : '单连接'}
                  {t.errorMessage ? ' · ' + t.errorMessage : ''}
                </span>
                <ChunkMap chunks={t.chunks} total={t.totalSize} />
              </div>

              <div className="col size">{formatBytes(t.totalSize)}</div>

              <div className="col progress">
                <div className="progress-bar">
                  <div className={'progress-fill' + (active ? ' anim' : '')} style={{ width: pct + '%' }} />
                </div>
                <small>{pct.toFixed(1)}%</small>
              </div>

              <div className="col speed">{active ? formatSpeed(t.speed) : '--'}</div>

              <div className="col left">{active ? formatDuration(t.timeLeft) : '--'}</div>

              <div className="col status">
                <span className={'tag ' + t.status}>{STATUS_TEXT[t.status]}</span>
                {t.status === 'downloading' && (
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      void onPause(t.id)
                    }}
                  >
                    暂停
                  </button>
                )}
                {(t.status === 'paused' || t.status === 'failed') && (
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      void onResume(t.id)
                    }}
                  >
                    继续
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {menu && (
        <div className="ctx-menu" ref={menuRef} style={{ left: menu.x, top: menu.y }}>
          <button type="button" onClick={() => void onOpenFile(menu.task.savePath)}>
            打开文件
          </button>
          <button type="button" onClick={() => void onShowInFolder(menu.task.savePath)}>
            打开所在文件夹
          </button>
          <div className="ctx-sep" />
          {menu.task.status === 'downloading' ? (
            <button type="button" onClick={() => void onPause(menu.task.id).then(() => setMenu(null))}>
              暂停任务
            </button>
          ) : (
            <button type="button" onClick={() => void onResume(menu.task.id).then(() => setMenu(null))}>
              继续任务
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              onSelect(menu.task.id)
              onRedo()
              setMenu(null)
            }}
          >
            重新下载
          </button>
          <button type="button" onClick={() => void copyUrl(menu.task.url)}>
            复制链接地址
          </button>
          <div className="ctx-sep" />
          <button
            type="button"
            onClick={() => {
              onSelect(menu.task.id)
              onDelete(false)
              setMenu(null)
            }}
          >
            从列表移除
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              onSelect(menu.task.id)
              onDelete(true)
              setMenu(null)
            }}
          >
            删除并丢弃文件
          </button>
        </div>
      )}
    </div>
  )
}
