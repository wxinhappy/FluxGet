/**
 * 页面媒体资源嗅探
 * 来源三路：media 元素、performance 资源计时、动态观察器
 * 同时在视频右上角注入「用 FluxGet 下载」悬浮按钮（IDM 同款交互）
 */
;(() => {
  const MEDIA_EXT = /\.(mp4|mkv|avi|mov|m4v|flv|webm|ts|m3u8|mpd|mp3|m4a|flac|wav|aac|ogg|ogv)(\?|#|$)/i
  const collected = new Map()

  function addMedia(entry) {
    if (!entry || !entry.url) return
    if (!/^https?:/i.test(entry.url)) return
    if (collected.has(entry.url)) {
      const prev = collected.get(entry.url)
      if (!prev.title && entry.title) collected.set(entry.url, { ...prev, title: entry.title })
      return
    }
    collected.set(entry.url, entry)
  }

  function fileNameFromUrl(url) {
    try {
      const u = new URL(url)
      const last = u.pathname.split('/').pop() || 'download'
      return decodeURIComponent(last)
    } catch (e) {
      return 'download'
    }
  }

  /** 扫描页面中的 video / audio / source 元素 */
  function scanElements() {
    document.querySelectorAll('video, audio').forEach((el) => {
      const src = el.currentSrc || el.src
      if (src) {
        addMedia({
          url: src,
          type: el.tagName.toLowerCase(),
          title: document.title || fileNameFromUrl(src)
        })
      }
      el.querySelectorAll('source').forEach((s) => {
        if (s.src) {
          addMedia({
            url: s.src,
            type: el.tagName.toLowerCase(),
            title: document.title || fileNameFromUrl(s.src)
          })
        }
      })
    })
  }

  /** 从 performance 资源计时中提取媒体请求 */
  function scanPerformance() {
    try {
      const entries = performance.getEntriesByType('resource')
      entries.forEach((e) => {
        const name = e.name || ''
        if (MEDIA_EXT.test(name)) {
          addMedia({
            url: name,
            type: 'resource',
            title: document.title || fileNameFromUrl(name)
          })
        }
      })
    } catch (e) {
      /* 部分页面禁用 performance API */
    }
  }

  /** 持续观察后续动态加载的媒体请求 */
  function observe() {
    try {
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((e) => {
          if (MEDIA_EXT.test(e.name || '')) {
            addMedia({
              url: e.name,
              type: 'resource',
              title: document.title || fileNameFromUrl(e.name)
            })
          }
        })
      })
      observer.observe({ entryTypes: ['resource'] })
    } catch (e) {
      /* 不支持时忽略 */
    }
  }

  const FLOATING_CLASS = 'fluxget-download-btn-container'
  const injectedWeak = new Set()

  /** 在视频右上角注入下载按钮 */
  function injectFloatingButtons() {
    document.querySelectorAll('video').forEach((video) => {
      if (injectedWeak.has(video)) return
      if (video.readyState === 0 && !video.src && !video.currentSrc) return
      injectedWeak.add(video)

      const container = document.createElement('div')
      container.className = FLOATING_CLASS
      container.style.cssText = [
        'position:absolute',
        'top:8px',
        'right:8px',
        'z-index:2147483647',
        'background:rgba(20,22,26,.92)',
        'color:#fff',
        'border-radius:16px',
        'padding:4px 10px',
        'font:12px/1.6 "Segoe UI",system-ui,sans-serif',
        'cursor:pointer',
        'box-shadow:0 4px 14px rgba(0,0,0,.4)',
        'display:flex',
        'align-items:center',
        'gap:5px',
        'user-select:none',
        'transition:opacity .18s',
        'opacity:.82'
      ].join(';')
      container.innerHTML =
        '<span style="font-weight:600">FluxGet 下载</span>'

      container.addEventListener('mouseenter', () => {
        container.style.opacity = '1'
      })
      container.addEventListener('mouseleave', () => {
        container.style.opacity = '.82'
      })

      container.addEventListener('click', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        const src = video.currentSrc || video.src
        if (!src) return
        chrome.runtime.sendMessage(
          { type: 'FLUXGET_DOWNLOAD', url: src, referrer: location.href },
          (res) => {
            const done = res && res.ok
            container.innerHTML = '<span>' + (done ? '已添加到 FluxGet' : 'FluxGet 未运行') + '</span>'
            setTimeout(() => {
              container.innerHTML = '<span style="font-weight:600">FluxGet 下载</span>'
            }, 1800)
          }
        )
      })

      const parent = video.parentElement
      if (!parent) return
      const pos = getComputedStyle(parent).position
      if (pos === 'static' || pos === '') parent.style.position = 'relative'
      parent.appendChild(container)
    })
  }

  function boot() {
    scanElements()
    scanPerformance()
    observe()
    injectFloatingButtons()
  }

  boot()

  // 页面动态插入视频时继续处理
  let timer = null
  const mo = new MutationObserver(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      scanElements()
      injectFloatingButtons()
    }, 800)
  })
  mo.observe(document.documentElement, { childList: true, subtree: true })

  // 响应后台/浮层的收集请求
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'FLUXGET_COLLECT') {
      scanElements()
      scanPerformance()
      const list = Array.from(collected.values()).map((m) => ({
        url: m.url,
        type: m.type,
        title: m.title || fileNameFromUrl(m.url)
      }))
      sendResponse({ media: list })
      return true
    }
    return false
  })
})()
