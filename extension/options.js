/* eslint-env browser */
const el = {
  enabled: document.getElementById('enabled'),
  interceptDownloads: document.getElementById('interceptDownloads'),
  notifyOnIntercept: document.getElementById('notifyOnIntercept'),
  minSizeBytes: document.getElementById('minSizeBytes'),
  port: document.getElementById('port'),
  blacklist: document.getElementById('blacklist'),
  save: document.getElementById('save'),
  saved: document.getElementById('saved')
}

const DEFAULTS = {
  enabled: true,
  interceptDownloads: true,
  preferResumable: true,
  port: 16888,
  minSizeBytes: 0,
  blacklist: ['.html', '.htm'],
  notifyOnIntercept: true
}

chrome.storage.local.get(['fluxgetOptions'], (stored) => {
  const opts = Object.assign({}, DEFAULTS, stored.fluxgetOptions || {})
  el.enabled.checked = opts.enabled !== false
  el.interceptDownloads.checked = opts.interceptDownloads !== false
  el.notifyOnIntercept.checked = opts.notifyOnIntercept !== false
  el.minSizeBytes.value = String(opts.minSizeBytes || 0)
  el.port.value = String(opts.port || DEFAULTS.port)
  el.blacklist.value = (opts.blacklist || []).join('\n')
})

el.save.addEventListener('click', () => {
  const blacklist = el.blacklist.value
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  const opts = {
    enabled: el.enabled.checked,
    interceptDownloads: el.interceptDownloads.checked,
    notifyOnIntercept: el.notifyOnIntercept.checked,
    minSizeBytes: Number(el.minSizeBytes.value) || 0,
    port: Number(el.port.value) || DEFAULTS.port,
    preferResumable: true,
    blacklist
  }

  chrome.storage.local.set({ fluxgetOptions: opts }, () => {
    chrome.runtime.sendMessage({ type: 'FLUXGET_OPTIONS_CHANGED' })
    el.saved.classList.add('show')
    setTimeout(() => el.saved.classList.remove('show'), 1800)
  })
})
