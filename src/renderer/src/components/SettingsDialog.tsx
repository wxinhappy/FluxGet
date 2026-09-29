import { useEffect, useState } from 'react'
import type { AppSettings, BridgeStatus, ProxyConfig } from '@shared/types'

export interface SettingsDialogProps {
  settings: AppSettings
  onClose: () => void
  onSave: (patch: Partial<AppSettings>) => void
}

type TabKey = 'general' | 'network' | 'browser' | 'proxy' | 'advanced'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'general', label: '常规' },
  { key: 'network', label: '连接与限速' },
  { key: 'browser', label: '浏览器支持' },
  { key: 'proxy', label: '代理' },
  { key: 'advanced', label: '高级' }
]

/** KB/s 与 bytes/s 互转，0 表示不限速 */
const kbToBytes = (kb: number): number => (kb > 0 ? Math.round(kb * 1024) : 0)
const bytesToKb = (b: number): number => (b > 0 ? Math.round(b / 1024) : 0)

export default function SettingsDialog({ settings, onClose, onSave }: SettingsDialogProps): JSX.Element {
  const [tab, setTab] = useState<TabKey>('general')
  const [draft, setDraft] = useState<AppSettings>({ ...settings })
  const [bridge, setBridge] = useState<BridgeStatus | null>(null)

  useEffect(() => {
    window.fluxget.getBridgeStatus().then(setBridge).catch(() => undefined)
  }, [])

  const patch = (p: Partial<AppSettings>): void => setDraft({ ...draft, ...p })
  const patchBrowser = (p: Partial<AppSettings['browser']>): void =>
    setDraft({ ...draft, browser: { ...draft.browser, ...p } })
  const patchProxy = (p: Partial<ProxyConfig>): void =>
    setDraft({ ...draft, proxy: { ...draft.proxy, ...p } })

  const pickDir = async (): Promise<void> => {
    const dir = await window.fluxget.selectDirectory(draft.downloadDir)
    if (dir) patch({ downloadDir: dir })
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>设置</h3>
          <button type="button" className="icon-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="settings-wrap">
          <div className="settings-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={'tab' + (tab === t.key ? ' active' : '')}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="settings-body">
            {tab === 'general' && (
              <>
                <label className="field">
                  <span>默认下载目录</span>
                  <div className="row">
                    <input className="input" value={draft.downloadDir} onChange={(e) => patch({ downloadDir: e.target.value })} />
                    <button type="button" className="ghost-btn" onClick={() => void pickDir()}>
                      浏览
                    </button>
                  </div>
                </label>
                <label className="field">
                  <span>同时进行的任务数</span>
                  <input
                    className="input small"
                    type="number"
                    min={1}
                    max={20}
                    value={draft.maxActiveTasks}
                    onChange={(e) => patch({ maxActiveTasks: Number(e.target.value) })}
                  />
                </label>
                <label className="check">
                  <input type="checkbox" checked={draft.autoStartNext} onChange={(e) => patch({ autoStartNext: e.target.checked })} />
                  <span>任务完成后自动开始下一个排队任务</span>
                </label>
              </>
            )}

            {tab === 'network' && (
              <>
                <label className="field">
                  <span>默认单任务连接数</span>
                  <div className="row">
                    <input
                      type="range"
                      min={1}
                      max={32}
                      value={draft.connections}
                      onChange={(e) => patch({ connections: Number(e.target.value) })}
                      className="range"
                    />
                    <input
                      className="input small"
                      type="number"
                      min={1}
                      max={32}
                      value={draft.connections}
                      onChange={(e) => patch({ connections: Number(e.target.value) })}
                    />
                  </div>
                </label>
                <label className="field">
                  <span>全局限速（KB/s，0 为不限）</span>
                  <input
                    className="input small"
                    type="number"
                    min={0}
                    value={bytesToKb(draft.globalSpeedLimit)}
                    onChange={(e) => patch({ globalSpeedLimit: kbToBytes(Number(e.target.value)) })}
                  />
                </label>
                <label className="field">
                  <span>单任务限速（KB/s，0 为不限）</span>
                  <input
                    className="input small"
                    type="number"
                    min={0}
                    value={bytesToKb(draft.taskSpeedLimit)}
                    onChange={(e) => patch({ taskSpeedLimit: kbToBytes(Number(e.target.value)) })}
                  />
                </label>
                <label className="field">
                  <span>连接超时（毫秒）</span>
                  <input
                    className="input small"
                    type="number"
                    min={1000}
                    step={1000}
                    value={draft.requestTimeout}
                    onChange={(e) => patch({ requestTimeout: Number(e.target.value) })}
                  />
                </label>
              </>
            )}

            {tab === 'browser' && (
              <>
                <div className="bridge-status">
                  <span className={'dot ' + (bridge?.running ? 'green' : 'red')} />
                  <span>
                    {bridge?.running
                      ? '本机服务运行中 · 端口 ' + bridge.port
                      : '本机服务未运行（安装扩展后需保持 FluxGet 开启）'}
                  </span>
                </div>

                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft.browser.enabled}
                    onChange={(e) => patchBrowser({ enabled: e.target.checked })}
                  />
                  <span>启用浏览器集成服务（供扩展连接）</span>
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft.browser.interceptDownloads}
                    onChange={(e) => patchBrowser({ interceptDownloads: e.target.checked })}
                  />
                  <span>接管浏览器下载（需在扩展中开启对应选项）</span>
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft.browser.watchClipboard}
                    onChange={(e) => patchBrowser({ watchClipboard: e.target.checked })}
                  />
                  <span>监视剪贴板链接（复制下载地址时自动弹出新建任务）</span>
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft.browser.notifyOnIntercept}
                    onChange={(e) => patchBrowser({ notifyOnIntercept: e.target.checked })}
                  />
                  <span>接管下载时显示系统通知</span>
                </label>
                <label className="field">
                  <span>服务端口（被占用时自动顺延）</span>
                  <input
                    className="input small"
                    type="number"
                    min={1024}
                    max={65535}
                    value={draft.browser.port}
                    onChange={(e) => patchBrowser({ port: Number(e.target.value) })}
                  />
                </label>

                <div className="install-guide">
                  <strong>安装浏览器扩展（Chrome / Edge）</strong>
                  <ol>
                    <li>扩展文件位于安装目录的 <code>extension</code> 文件夹</li>
                    <li>点击下方按钮打开浏览器的扩展管理页</li>
                    <li>开启右上角「开发者模式」</li>
                    <li>点击「加载已解压的扩展程序」，选择 <code>extension</code> 文件夹</li>
                    <li>固定到工具栏后，点击图标即可嗅探页面媒体并批量下载</li>
                  </ol>
                  <div className="guide-btns">
                    <button type="button" className="ghost-btn" onClick={() => void window.fluxget.openExtensionsPage()}>
                      打开 Chrome 扩展页
                    </button>
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => void window.fluxget.openExternal('https://microsoftedge.microsoft.com/addons')}
                    >
                      Edge 扩展中心
                    </button>
                  </div>
                </div>
              </>
            )}

            {tab === 'proxy' && (
              <>
                <label className="check">
                  <input type="checkbox" checked={draft.proxy.enabled} onChange={(e) => patchProxy({ enabled: e.target.checked })} />
                  <span>启用代理服务器</span>
                </label>
                <label className="field">
                  <span>类型</span>
                  <select className="input small" value={draft.proxy.type} onChange={(e) => patchProxy({ type: e.target.value as ProxyConfig['type'] })}>
                    <option value="http">HTTP</option>
                    <option value="https">HTTPS</option>
                    <option value="socks5">SOCKS5</option>
                  </select>
                </label>
                <div className="two-col">
                  <label className="field">
                    <span>主机</span>
                    <input className="input" value={draft.proxy.host} onChange={(e) => patchProxy({ host: e.target.value })} placeholder="127.0.0.1" />
                  </label>
                  <label className="field">
                    <span>端口</span>
                    <input className="input small" type="number" value={draft.proxy.port} onChange={(e) => patchProxy({ port: Number(e.target.value) })} />
                  </label>
                </div>
                <div className="two-col">
                  <label className="field">
                    <span>用户名（可选）</span>
                    <input className="input" value={draft.proxy.username ?? ''} onChange={(e) => patchProxy({ username: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>密码（可选）</span>
                    <input className="input" type="password" value={draft.proxy.password ?? ''} onChange={(e) => patchProxy({ password: e.target.value })} />
                  </label>
                </div>
              </>
            )}

            {tab === 'advanced' && (
              <>
                <label className="field">
                  <span>User-Agent</span>
                  <textarea className="input textarea" rows={3} value={draft.userAgent} onChange={(e) => patch({ userAgent: e.target.value })} />
                </label>
                <label className="field">
                  <span>失败重试次数</span>
                  <input className="input small" type="number" min={0} max={20} value={draft.maxRetries} onChange={(e) => patch({ maxRetries: Number(e.target.value) })} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={draft.insecureTLS} onChange={(e) => patch({ insecureTLS: e.target.checked })} />
                  <span>忽略 TLS 证书错误（自签名 / 过期证书场景）</span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={draft.minimizeToTray} onChange={(e) => patch({ minimizeToTray: e.target.checked })} />
                  <span>关闭窗口时最小化到系统托盘</span>
                </label>
              </>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="ghost-btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary-btn"
            onClick={() => {
              onSave(draft)
              onClose()
            }}
          >
            保存设置
          </button>
        </div>
      </div>
    </div>
  )
}
