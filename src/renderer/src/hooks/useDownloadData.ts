import { useEffect, useState } from 'react'
import type { EngineStats, TaskSnapshot } from '@shared/types'

const EMPTY_STATS: EngineStats = {
  activeCount: 0,
  totalSpeed: 0,
  totalDownloadedBytes: 0,
  taskCountByStatus: {
    pending: 0,
    probing: 0,
    downloading: 0,
    paused: 0,
    completed: 0,
    failed: 0,
    canceled: 0
  }
}

/** 订阅主进程推送的任务列表与全局统计 */
export function useDownloadData(): { tasks: TaskSnapshot[]; stats: EngineStats } {
  const [tasks, setTasks] = useState<TaskSnapshot[]>([])
  const [stats, setStats] = useState<EngineStats>(EMPTY_STATS)

  useEffect(() => {
    window.fluxget.getTasks().then(setTasks).catch(() => undefined)
    window.fluxget.onTaskUpdate(setTasks)
    window.fluxget.onStats(setStats)
  }, [])

  return { tasks, stats }
}
