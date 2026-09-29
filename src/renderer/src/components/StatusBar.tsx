import type { EngineStats } from '@shared/types'
import { formatBytes, formatSpeed } from '../utils/format'

export interface StatusBarProps {
  stats: EngineStats
  downloadDir?: string
}

export default function StatusBar({ stats, downloadDir }: StatusBarProps): JSX.Element {
  return (
    <footer className="statusbar">
      <div className="status-item">
        <span className="dot green" />
        <span>引擎已就绪</span>
      </div>
      <div className="status-item">
        <span className="label">下载中</span>
        <strong>{stats.activeCount}</strong>
      </div>
      <div className="status-item">
        <span className="label">总速度</span>
        <strong className="accent">{formatSpeed(stats.totalSpeed)}</strong>
      </div>
      <div className="status-item">
        <span className="label">已接收</span>
        <strong>{formatBytes(stats.totalDownloadedBytes)}</strong>
      </div>
      <div className="spacer" />
      <div className="status-item mono" title={downloadDir}>
        <span className="label">保存至</span>
        <strong>{downloadDir ?? '--'}</strong>
      </div>
    </footer>
  )
}
