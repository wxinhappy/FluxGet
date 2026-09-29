/**
 * FluxGet 扩展后台服务
 * 负责：与本机桥接服务通信、接管浏览器下载、右键菜单、消息中转
 */
const DEFAULT_PORTS = [
  16888, 16889, 16890, 16891, 16892, 16893, 16894, 16895, 16896, 16897, 16898, 16899
]

const DEFAULT_OPTIONS = {
  enabled: true,
  interceptDownloads: true,
  preferResumable: true,
  port: 16888,
  minSizeBytes: 0, // 小于该体积的下载不接管（0 表示全部接管）
  blacklist: ['.html', '.htm'],
  notifyOnIntercept: true
}

/** 会话内缓存，service worker 休眠后会失效，因此关键信息也落 storage */
let session = { port: 16888, token: '', options: { ...DEFAULT_OPTIONS } }

async function loadOptions() {
  const stored = await chrome.storage.local.get(['fluxgetOptions'])
  session.options = { ...DEFAULT_OPTIONS, ...(stored.fluxgetOptions || {}) }
  session.port = Number(session.options.port) || DEFAULT_OPTIONS.port
  return session.options
}

function buildUrl(path) {
  return 'http://127.0.0.1:' + session.port + path
}

/** 探测本机桥接服务是否在线 */
async function probe() {
  const candidates = [session.port, ...DEFAULT_PORTS.filter((p) => p !== session.port)]
  for (const port of candidates) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 900)
      const res = await fetch('http://127.0.0.1:' + port + '/api/health', {
        method: 'GET',
        signal: controller.signal
      })
      clearTimeout(timer)
      if (res.ok) {
        const data = await res.json()
        if (data && data.name === 'FluxGet') {
          session.port = port
          return true
        }
      }
    } catch (e) {
      /* 该端口不可用，继续下一个 */
    }
  }
  return false
}

/** 换取或刷新 token */
async function ensureToken() {
  if (session.token) return session.token
  try {
    const res = await fetch(buildUrl('/api/token'), { method: 'GET' })
    if (res.ok) {
      const data = await res.json()
      session.token = data.token || ''
      return session.token
    }
  } catch (e) {
    /* 服务离线 */
  }
  return ''
}

async function postJson(path, body) {
  const token = await ensureToken()
  if (!token) return { ok: false, error: 'FLUXGET_OFFLINE' }
  try {
    const res = await fetch(buildUrl(path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FluxGet-Token': token
      },
      body: JSON.stringify(body)
    })
    return await res.json()
  } catch (e) {
    return { ok: false, error: 'FLUXGET_OFFLINE' }
  }
}

function notify(title, message) {
  if (!session.options.notifyOnIntercept) return
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: title,
      message: message
    })
  } catch (e) {
    /* 通知权限未授予时忽略 */
  }
}

/** 判断是否应该接管该下载 */
function shouldIntercept(item) {
  if (!session.options.enabled || !session.options.interceptDownloads) return false
  const url = item.url || item.finalUrl || ''
  if (!/^https?:/i.test(url)) return false
  const lower = url.split('?')[0].toLowerCase()
  if (session.options.blacklist.some((ext) => lower.endsWith(ext))) return false
  if (session.options.minSizeBytes > 0 && item.fileSize && item.fileSize < session.options.minSizeBytes) {
    return false
  }
  return true
}

/**
 * 核心接管逻辑
 * 在浏览器准备写文件时取消本次下载，交给 FluxGet 从该 URL 重新拉取。
 */
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!shouldIntercept(item)) {
    suggest()
    return
  }

  void (async () => {
    const online = await probe()
    if (!online) {
      // 本机未运行 FluxGet，放行给浏览器自行下载
      suggest()
      return
    }

    const res = await postJson('/api/quick-download', {
      url: item.finalUrl || item.url,
      fileName: item.filename ? item.filename.split(/[\\/]/).pop() : undefined,
      referrer: item.referrer || undefined
    })

    if (res && res.ok) {
      notify('已交给 FluxGet 下载', (item.filename || item.url || '').slice(0, 80))
    } else {
      notify('接管失败', 'FluxGet 未响应，已使用浏览器下载')
    }
    // 无论成功与否都取消浏览器自身的下载
    try {
      await chrome.downloads.cancel(item.id)
      await chrome.downloads.erase({ id: item.id })
    } catch (e) {
      /* 下载可能已完成 */
    }
    suggest()
  })()

  // 返回 true 表示异步调用 suggest
  return true
})

/** 右键菜单 */
function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'fluxget-link',
      title: '使用 FluxGet 下载链接',
      contexts: ['link']
    })
    chrome.contextMenus.create({
      id: 'fluxget-video',
      title: '使用 FluxGet 下载视频',
      contexts: ['video']
    })
    chrome.contextMenus.create({
      id: 'fluxget-audio',
      title: '使用 FluxGet 下载音频',
      contexts: ['audio']
    })
    chrome.contextMenus.create({
      id: 'fluxget-image',
      title: '使用 FluxGet 下载图片',
      contexts: ['image']
    })
    chrome.contextMenus.create({
      id: 'fluxget-page',
      title: '使用 FluxGet 抓取本页资源',
      contexts: ['page', 'action']
    })
  })
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const online = await probe()
  if (!online) {
    notify('FluxGet 未运行', '请先启动 FluxGet 下载管理器')
    return
  }

  let url = ''
  if (info.menuItemId === 'fluxget-link') url = info.linkUrl
  else if (info.menuItemId === 'fluxget-video') url = info.srcUrl
  else if (info.menuItemId === 'fluxget-audio') url = info.srcUrl
  else if (info.menuItemId === 'fluxget-image') url = info.srcUrl

  if (url) {
    const res = await postJson('/api/quick-download', {
      url,
      referrer: tab && tab.url ? tab.url : undefined
    })
    notify(res && res.ok ? '已加入 FluxGet' : '下载失败', (url || '').slice(0, 80))
    return
  }

  if (info.menuItemId === 'fluxget-page' && tab && tab.id) {
    // 向当前页面注入嗅探脚本并批量下发
    const media = await requestMediaFromTab(tab.id)
    if (media.length === 0) {
      notify('未发现媒体资源', '该页面没有检测到视频或音频直链')
      return
    }
    const res = await postJson('/api/tasks', {
      urls: media.map((m) => m.url),
      referrer: tab.url
    })
    notify(res && res.ok ? '已批量加入 FluxGet' : '下载失败', '共 ' + media.length + ' 个资源')
  }
})

function requestMediaFromTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'FLUXGET_COLLECT' }, (response) => {
      resolve(response && response.media ? response.media : [])
    })
  })
}

/** 接收内容脚本与 popup 的消息 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FLUXGET_HEALTH') {
    void (async () => {
      const online = await probe()
      sendResponse({ online, port: session.port })
    })()
    return true
  }

  if (msg.type === 'FLUXGET_DOWNLOAD') {
    void (async () => {
      const online = await probe()
      if (!online) {
        sendResponse({ ok: false, error: 'FLUXGET_OFFLINE' })
        return
      }
      const res = await postJson('/api/quick-download', {
        url: msg.url,
        fileName: msg.fileName,
        dirPath: msg.dirPath,
        referrer: msg.referrer
      })
      sendResponse(res)
    })()
    return true
  }

  if (msg.type === 'FLUXGET_DOWNLOAD_BATCH') {
    void (async () => {
      const online = await probe()
      if (!online) {
        sendResponse({ ok: false, error: 'FLUXGET_OFFLINE' })
        return
      }
      const res = await postJson('/api/tasks', {
        urls: msg.urls,
        referrer: msg.referrer,
        dirPath: msg.dirPath
      })
      sendResponse(res)
    })()
    return true
  }

  if (msg.type === 'FLUXGET_OPTIONS_CHANGED') {
    void loadOptions().then(() => sendResponse({ ok: true }))
    return true
  }

  return false
})

chrome.runtime.onInstalled.addListener(() => {
  setupMenus()
  void loadOptions()
  void probe()
})

chrome.runtime.onStartup.addListener(() => {
  void loadOptions()
  void probe()
})

void loadOptions()
