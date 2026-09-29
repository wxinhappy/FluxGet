import type { TaskStatus } from '@shared/types'

export interface ToolbarProps {
  hasSelection: boolean
  selectedStatus?: TaskStatus
  onNewTask: () => void
  onPause: () => void
  onResume: () => void
  onRedo: () => void
  onDelete: (deleteFile: boolean) => void
  onClearFinished: () => void
  onOpenSettings: () => void
}

function IconButton({
  label,
  disabled,
  onClick,
  icon,
  danger
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  icon: JSX.Element
  danger?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      className={'tool-btn' + (danger ? ' danger' : '')}
      disabled={disabled}
      onClick={onClick}
      title={label}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

export default function Toolbar({
  hasSelection,
  selectedStatus,
  onNewTask,
  onPause,
  onResume,
  onRedo,
  onDelete,
  onClearFinished,
  onOpenSettings
}: ToolbarProps): JSX.Element {
  const pausable = hasSelection && selectedStatus === 'downloading'
  const resumable = hasSelection && (selectedStatus === 'paused' || selectedStatus === 'failed')

  return (
    <header className="toolbar">
      <button type="button" className="primary-btn" onClick={onNewTask}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        <span>新建任务</span>
      </button>

      <div className="divider" />

      <IconButton
        label="暂停"
        disabled={!pausable}
        onClick={onPause}
        icon={
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M9 5v14" />
            <path d="M15 5v14" />
          </svg>
        }
      />
      <IconButton
        label="继续"
        disabled={!resumable}
        onClick={onResume}
        icon={
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
            <path d="M7 4l12 8-12 8z" />
          </svg>
        }
      />
      <IconButton
        label="重新下载"
        disabled={!hasSelection}
        onClick={onRedo}
        icon={
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5" />
            <path d="M4 4v4.5h4.5" />
            <path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.5" />
            <path d="M20 20v-4.5h-4.5" />
          </svg>
        }
      />
      <IconButton
        label="删除"
        danger
        disabled={!hasSelection}
        onClick={() => onDelete(false)}
        icon={
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 7h16" />
            <path d="M9 7V4h6v3" />
            <path d="M6 7l1 13h10l1-13" />
          </svg>
        }
      />

      <div className="divider" />

      <IconButton
        label="清理已完成"
        onClick={onClearFinished}
        icon={
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6h16" />
            <path d="M10 10v8" />
            <path d="M14 10v8" />
          </svg>
        }
      />

      <div className="spacer" />

      <IconButton
        label="设置"
        onClick={onOpenSettings}
        icon={
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.87-1.2l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15H4.5a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 11.5 4.5V4.4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.87 1.2l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0 1.2 2.87h.1a2 2 0 1 1 0 4h-.1z" />
          </svg>
        }
      />
    </header>
  )
}
