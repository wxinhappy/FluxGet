/**
 * 发布前自检：确认版本号统一、双平台产物齐全。
 * 用法：npm run release:check
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
}

const pkgVersion = readJson('package.json').version
const problems = []
const notes = []

// 1. 版本一致性
const extManifest = readJson('extension/manifest.json')
if (extManifest.version !== pkgVersion) {
  problems.push(
    '扩展版本 ' + extManifest.version + ' 与 package.json ' + pkgVersion + ' 不一致（执行 npm run version:sync）'
  )
} else {
  notes.push('版本号统一：' + pkgVersion)
}

// 2. 产物齐全性
const releaseDir = path.join(ROOT, 'release', pkgVersion)
const expected = [
  { file: 'FluxGet-Setup-' + pkgVersion + '-x64.exe', label: 'Windows 安装包 (x64)' },
  { file: 'FluxGet-Portable-' + pkgVersion + '-x64.exe', label: 'Windows 便携版 (x64)' },
  { file: 'FluxGet-' + pkgVersion + '-x64.dmg', label: 'macOS Intel (x64)' },
  { file: 'FluxGet-' + pkgVersion + '-arm64.dmg', label: 'macOS Apple 芯片 (arm64)' }
]

if (!fs.existsSync(releaseDir)) {
  problems.push('缺少发布目录 release/' + pkgVersion + '/')
} else {
  const actual = fs.readdirSync(releaseDir)
  for (const item of expected) {
    if (actual.includes(item.file)) notes.push('已就绪  ' + item.label)
    else problems.push('缺少产物  ' + item.label + '  (' + item.file + ')')
  }
}

// 3. 图标资源
for (const asset of ['build/icon.ico', 'build/icon.icns', 'build/entitlements.mac.plist', 'extension/manifest.json']) {
  if (!fs.existsSync(path.join(ROOT, asset))) problems.push('缺少资源 ' + asset)
}

console.log('')
console.log('===== 发布自检 · 版本 ' + pkgVersion + ' =====')
for (const n of notes) console.log('  OK    ' + n)
for (const p of problems) console.log('  MISS  ' + p)
console.log('')

if (problems.length === 0) {
  console.log('全部通过：双平台产物齐全，可以发布')
  process.exit(0)
}
console.log(problems.length + ' 项待处理')
console.log('提示：Windows 产物在本机执行 npm run dist；macOS 产物需在 Mac 或 GitHub Actions 执行 npm run dist:mac')
process.exit(1)
