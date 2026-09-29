/**
 * 版本同步：以 package.json 为唯一来源，同步到浏览器扩展 manifest。
 * 每次发布前自动执行，避免两个平台版本漂移。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version

const targets = ['extension/manifest.json']

let changed = false
for (const rel of targets) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) continue
  const raw = fs.readFileSync(file, 'utf8')
  const json = JSON.parse(raw)
  if (json.version === version) {
    console.log('版本一致  ' + rel + '  ' + version)
    continue
  }
  json.version = version
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
  changed = true
  console.log('已同步    ' + rel + '  ' + json.version + ' -> ' + version)
}

console.log(changed ? '版本号已统一为 ' + version : '所有目标版本均为 ' + version)
