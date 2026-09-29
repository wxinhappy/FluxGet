import type { ChunkState } from '@shared/types'

export interface ChunkMapProps {
  chunks: ChunkState[]
  total: number
}

/**
 * 分片可视化：横向展示每个连接的区间与完成度。
 * 可以直观看到动态分裂产生的多段抢占情况。
 */
export default function ChunkMap({ chunks, total }: ChunkMapProps): JSX.Element | null {
  if (total <= 0 || chunks.length === 0) return null

  return (
    <div className="chunk-map">
      {chunks.map((c) => {
        const span = c.end - c.start + 1
        const widthPct = Math.min(100, (span / total) * 100)
        const fillPct = Math.min(100, (c.downloaded / span) * 100)
        const cls = ['chunk', c.status === 'running' ? 'running' : '', c.status === 'done' ? 'done' : ''].join(' ').trim()
        return (
          <div
            key={c.id}
            className={cls}
            style={{ width: widthPct + '%' }}
            title={`连接 ${c.id}：${c.downloaded} / ${span} 字节`}
          >
            <div className="chunk-fill" style={{ width: fillPct + '%' }} />
          </div>
        )
      })}
    </div>
  )
}
