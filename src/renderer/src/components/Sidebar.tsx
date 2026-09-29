import type { TaskCategory } from '@shared/types'

export interface SidebarProps {
  category: TaskCategory
  onChange: (c: TaskCategory) => void
  counts: Record<TaskCategory, number>
}

interface Item {
  key: TaskCategory
  label: string
  path: JSX.Element
}

const ITEMS: Item[] = [
  {
    key: 'all',
    label: '全部任务',
    path: (
      <>
        <path d="M4 6h16" />
        <path d="M4 12h16" />
        <path d="M4 18h16" />
      </>
    )
  },
  {
    key: 'downloading',
    label: '下载中',
    path: (
      <>
        <path d="M12 4v12" />
        <path d="M6 12l6 6 6-6" />
      </>
    )
  },
  {
    key: 'completed',
    label: '已完成',
    path: (
      <>
        <path d="M5 13l4 4L19 7" />
      </>
    )
  },
  {
    key: 'paused',
    label: '已暂停',
    path: (
      <>
        <path d="M9 5v14" />
        <path d="M15 5v14" />
      </>
    )
  },
  {
    key: 'failed',
    label: '失败',
    path: (
      <>
        <path d="M6 6l12 12" />
        <path d="M18 6L6 18" />
      </>
    )
  }
]

export default function Sidebar({ category, onChange, counts }: SidebarProps): JSX.Element {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v12" />
            <path d="M7 11l5 5 5-5" />
            <path d="M5 21h14" />
          </svg>
        </div>
        <div className="brand-text">
          <strong>FluxGet</strong>
          <span>多线程下载管理器</span>
        </div>
      </div>

      <nav className="nav">
        {ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={'nav-item' + (category === item.key ? ' active' : '')}
            onClick={() => onChange(item.key)}
          >
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {item.path}
            </svg>
            <span>{item.label}</span>
            <em>{counts[item.key] ?? 0}</em>
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="engine-badge">
          <span className="pulse" />
          <span>引擎运行中</span>
        </div>
        <div className="hint-text">Ctrl + N 新建任务</div>
      </div>
    </aside>
  )
}
