/* eslint-env browser */
const listEl = document.getElementById('list')
const countEl = document.getElementById('count')
const dotEl = document.getElementById('dot')
const statusEl = document.getElementById('statusText')
const btnAll = document.getElementById('downloadAll')
const btnSelected = document.getElementById('downloadSelected')
const interceptEl = document.getElementById('intercept')
const openOptions = document.getElementById('openOptions')

let mediaList = []
let online = false

function setStatus(state, text) {
  dotEl.className = 'dot' + (state === 'online' ? ' online' : '')
  statusEl.textContent = text
}

function shortName(url) {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').pop()
    return decodeURIComponent(last || u.hostname)
  } catch (e) {
    return url.slice(0, 60)
  }
}

function humanHost(url) {
  try {
    return new URL(url).hostname
  } catch (e) {
    return ''
  }
}

function renderList() {
  listEl.innerHTML = ''
  if (mediaList.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = online ? '本页未检测到视频 / 音频直链' : 'FluxGet 未运行'
    listEl.appendChild(empty)
    return
  }

  mediaList.forEach((item, index) => {
    const row = document.createElement('div')
    row.className = 'row'

    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = index === 0
    cb.dataset.index = String(index)

    const meta = document.createElement('div')
    meta.className = 'meta'

    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = item.title || shortName(item.url)
    name.title = item.url

    const sub = document.createElement('div')
    sub.className = 'sub'
    sub.textContent = item.type + ' · ' + humanHost(item.url)

    meta.appendChild(name)
    meta.appendChild(sub)
    row.appendChild(cb)
    row.appendChild(meta)
    listEl.appendChild(row)
  })
}

function selectedUrls() {
  return Array.from(listEl.querySelectorAll('input[type=checkbox]'))
    .filter((cb) => cb.checked)
    .map((cb) => mediaList[Number(cb.dataset.index)].url)
}

function sendDownload(urls) {
  if (urls.length === 0) return
  btnAll.disabled = true
  btnSelected.disabled = true
  chrome.runtime.sendMessage({ type: 'FLUXGET_DOWNLOAD_BATCH', urls }, (res) => {
    btnAll.disabled = mediaList.length === 0
    btnSelected.disabled = false
    if (res && res.ok) {
      statusEl.textContent = '已发送 ' + urls.length + ' 个任务'
    } else {
      statusEl.textContent = res && res.error === 'FLUXGET_OFFLINE' ? 'FluxGet 未运行' : '发送失败'
    }
    setTimeout(() => {
      statusEl.textContent = online ? '已连接' : '未连接'
    }, 2200)
  })
}

btnAll.addEventListener('click', () => {
  sendDownload(mediaList.map((m) => m.url))
})

btnSelected.addEventListener('click', () => {
  sendDownload(selectedUrls())
})

openOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
})

interceptEl.addEventListener('change', () => {
  chrome.storage.local.get(['fluxgetOptions'], (stored) => {
    const opts = Object.assign({}, stored.fluxgetOptions || {})
    opts.interceptDownloads = interceptEl.value === 'on'
    chrome.storage.local.set({ fluxgetOptions: opts }, () => {
      chrome.runtime.sendMessage({ type: 'FLUXGET_OPTIONS_CHANGED' })
    })
  })
})

// 初始化：先检测本机服务，再扫描当前页面
chrome.runtime.sendMessage({ type: 'FLUXGET_HEALTH' }, (health) => {
  online = !!(health && health.online)
  setStatus(online ? 'online' : 'offline', online ? '已连接 · 端口 ' + health.port : 'FluxGet 未运行')
})

chrome.storage.local.get(['fluxgetOptions'], (stored) => {
  const opts = stored.fluxgetOptions || {}
  interceptEl.value = opts.interceptDownloads === false ? 'off' : 'on'
})

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0]
  if (!tab || !tab.id) {
    countEl.textContent = '0 个'
    renderList()
    return
  }
  chrome.tabs.sendMessage(tab.id, { type: 'FLUXGET_COLLECT' }, (response) => {
    mediaList = response && response.media ? response.media : []
    countEl.textContent = mediaList.length + ' 个'
    btnAll.disabled = mediaList.length === 0 || !online
    btnSelected.disabled = mediaList.length === 0 || !online
    renderList()
  })
})
