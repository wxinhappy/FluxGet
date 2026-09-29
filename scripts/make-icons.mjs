import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const EXT_ICON_DIR = path.join(ROOT, 'extension', 'icons')
const BUILD_DIR = path.join(ROOT, 'build')

/* ================= PNG 编码 ================= */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0
    rgba.subarray(y * width * 4, (y + 1) * width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ================= 图形绘制 ================= */

const COLOR_TOP = [0x4c, 0x8d, 0xff]
const COLOR_BOTTOM = [0x6f, 0x5c, 0xff]
const WHITE = [0xff, 0xff, 0xff]

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t)
}

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

/**
 * 在超采样画布上绘制
 * @param withBackground 是否绘制渐变圆角底（托盘模板图不需要底色）
 * @param arrowColor 箭头颜色
 */
function paint(size, withBackground, arrowColor) {
  const S = size
  const canvas = new Float32Array(S * S * 4)

  const pad = S * 0.06
  const x0 = pad
  const y0 = pad
  const x1 = S - pad
  const y1 = S - pad
  const radius = S * 0.22

  const cx = S / 2
  const shaftW = S * 0.16
  const shaftTop = S * 0.26
  const shaftBottom = S * 0.56
  const headTop = S * 0.5
  const headTip = S * 0.76
  const headW = S * 0.3

  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const idx = (y * S + x) * 4
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      if (withBackground) {
        if (!inRoundRect(x, y, x0, y0, x1, y1, radius)) continue
        const t = (y - y0) / Math.max(1, y1 - y0)
        r = lerp(COLOR_TOP[0], COLOR_BOTTOM[0], t)
        g = lerp(COLOR_TOP[1], COLOR_BOTTOM[1], t)
        b = lerp(COLOR_TOP[2], COLOR_BOTTOM[2], t)
        a = 1
      }

      let onArrow = false
      if (x >= cx - shaftW / 2 && x <= cx + shaftW / 2 && y >= shaftTop && y <= shaftBottom) {
        onArrow = true
      }
      if (y >= headTop && y <= headTip) {
        const progress = (headTip - y) / Math.max(1, headTip - headTop)
        const half = headW * (1 - progress)
        if (half > 0 && x >= cx - half && x <= cx + half) onArrow = true
      }

      if (onArrow) {
        r = arrowColor[0]
        g = arrowColor[1]
        b = arrowColor[2]
        a = 1
      }

      canvas[idx] = r
      canvas[idx + 1] = g
      canvas[idx + 2] = b
      canvas[idx + 3] = a
    }
  }
  return canvas
}

/** 超采样后下采样输出 RGBA 缓冲 */
function renderRGBA(size, withBackground = true, arrowColor = WHITE, ss = 4) {
  const big = paint(size * ss, withBackground, arrowColor)
  const B = size * ss
  const out = Buffer.alloc(size * size * 4)

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let dy = 0; dy < ss; dy += 1) {
        for (let dx = 0; dx < ss; dx += 1) {
          const idx = ((y * ss + dy) * B + (x * ss + dx)) * 4
          const alpha = big[idx + 3]
          r += big[idx] * alpha
          g += big[idx + 1] * alpha
          b += big[idx + 2] * alpha
          a += alpha
        }
      }
      const o = (y * size + x) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
        out[o + 3] = Math.round((a / (ss * ss)) * 255)
      }
    }
  }
  return out
}

/* ================= Windows ICO ================= */

function encodeICO(sizes) {
  const images = sizes.map((size) => ({
    size,
    png: encodePNG(size, size, renderRGBA(size))
  }))

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const entrySize = 16
  let offset = header.length + entrySize * images.length
  const entries = []
  for (const img of images) {
    const e = Buffer.alloc(entrySize)
    e[0] = img.size >= 256 ? 0 : img.size
    e[1] = img.size >= 256 ? 0 : img.size
    e[2] = 0 // color count (true color)
    e[3] = 0 // reserved
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bit count
    e.writeUInt32LE(img.png.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += img.png.length
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

/* ================= macOS ICNS ================= */

function icnsEntry(type, pngBuffer) {
  const head = Buffer.alloc(8)
  head.write(type, 0, 'ascii')
  head.writeUInt32BE(pngBuffer.length + 8, 4)
  return Buffer.concat([head, pngBuffer])
}

function encodeICNS() {
  // Apple 规范：按 PNG 条目组织，尺寸与类型对应
  const specs = [
    { type: 'ic11', size: 32 },
    { type: 'ic12', size: 64 },
    { type: 'ic07', size: 128 },
    { type: 'ic08', size: 256 },
    { type: 'ic09', size: 512 },
    { type: 'ic10', size: 1024 }
  ]

  const entries = specs.map((s) => {
    // 大尺寸本身已足够平滑，降低超采样倍数以控制生成耗时
    const ss = s.size >= 512 ? 1 : s.size >= 128 ? 2 : 4
    return icnsEntry(s.type, encodePNG(s.size, s.size, renderRGBA(s.size, true, WHITE, ss)))
  })

  const total = entries.reduce((n, e) => n + e.length, 0)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(total + 8, 4)
  return Buffer.concat([header, ...entries])
}

/* ================= 输出 ================= */

fs.mkdirSync(EXT_ICON_DIR, { recursive: true })
fs.mkdirSync(BUILD_DIR, { recursive: true })

function write(file, buf) {
  fs.writeFileSync(file, buf)
  console.log('生成 ' + path.relative(ROOT, file) + '  (' + buf.length + ' 字节)')
}

// 扩展图标（Chrome 扩展用 PNG）
for (const size of [16, 32, 48, 128]) {
  write(path.join(EXT_ICON_DIR, 'icon' + size + '.png'), encodePNG(size, size, renderRGBA(size)))
}

// Windows 安装包图标
write(path.join(BUILD_DIR, 'icon.ico'), encodeICO([16, 32, 48, 256]))

// macOS 应用图标
write(path.join(BUILD_DIR, 'icon.icns'), encodeICNS())

// 通用 PNG（Linux / 文档）
write(path.join(BUILD_DIR, 'icon.png'), encodePNG(512, 512, renderRGBA(512, true, WHITE, 2)))

// Windows 托盘图标（彩色）
write(path.join(BUILD_DIR, 'tray.png'), encodePNG(32, 32, renderRGBA(32)))

// macOS 托盘模板图标（纯黑 + alpha，由系统按明暗模式着色）
write(path.join(BUILD_DIR, 'trayTemplate.png'), encodePNG(16, 16, renderRGBA(16, false, [0, 0, 0], 4)))
