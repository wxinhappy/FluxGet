import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, CreateTaskPayload, ProbeResult } from '@shared/types'
import { formatBytes } from '../utils/format'

export interface NewTaskDialogProps {
  settings: AppSettings
  /** 打开时预填的地址（如剪贴板捕获） */
  initialUrl?: string
  onClose: () => void
  onSubmit: (payload: CreateTaskPayload | { urls: string[] }) => void
}

export default function NewTaskDialog({ settings, initialUrl, onClose, onSubmit }: NewTaskDialogProps): JSX.Element {
  const [rawUrls, setRawUrls] = useState(initialUrl ?? '')
  const [dirPath, setDirPath] = useState(settings.downloadDir)
  const [fileName, setFileName] = useState('')
  const [connections, setConnections] = useState(settings.connections)
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<ProbeResult | null>(null)

  const urls = useMemo(
    () => rawUrls.split('\n').map((u) => u.trim()).filter((u) => u.length > 0),
    [rawUrls]
  )
  const single = urls.length === 1 ? urls[0] : ''
  const valid = urls.length > 0 && urls.every((u) => u.startsWith('http://') || u.startsWith('https://'))

  // 单个 URL 时实时探测资源信息
  useEffect(() => {
    if (!single) {
      setProbe(null)
      return
    }
    let cancelled = false
    setProbing(true)
    setProbe(null)
    const timer = window.setTimeout(() => {
      window.fluxget
        .probeUrl(single)
        .then((res) => {
          if (!cancelled) setProbe(res)
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setProbing(false)
        })
    }, 700)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [single])

  const pickDir = async (): Promise<void> => {
    const dir = await window.fluxget.selectDirectory(dirPath)
    if (dir) setDirPath(dir)
    else await window.fluxget.selectDirectory()
  }

  const submit = (): void => {
    if (!valid) return
    if (urls.length > 1) {
      onSubmit({ urls })
    } else {
      const payload: CreateTaskPayload = { url: urls[0], dirPath, connections }
      if (fileName.trim()) payload.fileName = fileName.trim()
      onSubmit(payload)
    }
    onClose()
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>新建下载任务</h3>
          <button type="button" className="icon-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          <label className="field">
            <span>下载地址</span>
            <textarea
              className="input textarea"
              placeholder={'每行一个地址，支持批量导入\nhttps://example.com/file.zip'}
              value={rawUrls}
              onChange={(e) => setRawUrls(e.target.value)}
              rows={4}
              autoFocus
            />
          </label>

          <label className="field">
            <span>保存到</span>
            <div className="row">
              <input className="input" value={dirPath} onChange={(e) => setDirPath(e.target.value)} />
              <button type="button" className="ghost-btn" onClick={() => void pickDir()}>
                浏览
              </button>
            </div>
          </label>

          <div className="two-col">
            <label className="field">
              <span>文件名（可选）</span>
              <input
                className="input"
                placeholder={probe?.ok ? probe.fileName : '留空自动识别'}
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                disabled={urls.length > 1}
              />
            </label>

            <label className="field">
              <span>并发连接数</span>
              <div className="row">
                <input
                  type="range"
                  min={1}
                  max={32}
                  value={connections}
                  onChange={(e) => setConnections(Number(e.target.value))}
                  className="range"
                />
                <input
                  className="input small"
                  type="number"
                  min={1}
                  max={32}
                  value={connections}
                  onChange={(e) => setConnections(Number(e.target.value))}
                />
              </div>
            </label>
          </div>

          <div className="probe-box">
            {urls.length === 0 && <span className="muted">输入地址后自动解析资源信息</span>}
            {urls.length > 1 && <span className="muted">批量模式：{urls.length} 个地址</span>}
            {probing && <span className="muted">正在解析资源…</span>}
            {!probing && probe?.ok && (
              <div className="probe-list">
                <span>
                  <em>文件名</em>
                  {probe.fileName}
                </span>
                <span>
                  <em>大小</em>
                  {probe.totalSize ? formatBytes(probe.totalSize) : '未知（流式下载）'}
                </span>
                <span>
                  <em>断点续传</em>
                  <strong className={probe.supportsRange ? 'ok' : 'no'}>
                    {probe.supportsRange ? '支持多线程' : '不支持，将单线程下载'}
                  </strong>
                </span>
                {probe.contentType && (
                  <span>
                    <em>类型</em>
                    {probe.contentType}
                  </span>
                )}
              </div>
            )}
            {!probing && probe && !probe.ok && <span className="err">解析失败：{probe.error}</span>}
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="ghost-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary-btn" disabled={!valid} onClick={submit}>
            立即下载
          </button>
        </div>
      </div>
    </div>
  )
}
