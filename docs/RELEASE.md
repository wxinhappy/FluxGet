# 发布流程（Windows + macOS 双平台同步）

## 铁律

**任何版本更新都必须同时提供 Windows 与 macOS 产物**，版本号以 `package.json` 为唯一来源，扩展 manifest 由 `npm run version:sync` 自动同步。

macOS 必须分别产出 **Intel（x64）** 与 **Apple 芯片（arm64）** 两个独立安装包，不做 universal 合并包（体积翻倍且无必要）。

## 为什么本地打不出 macOS 包

electron-builder 构建 macOS 产物依赖 Unix 权限位与符号链接，**官方限制只能在 macOS 上运行**，Windows 上会直接报：

```
Build for macOS is supported only on macOS
```

因此 macOS 产物有两条产出路径，任选其一。

## 路径一：GitHub Actions（推荐，无需 Mac）

推送版本 tag 即自动构建全部平台：

```bash
npm run version:sync          # 同步扩展版本号
git add -A && git commit -m "release: v1.2.0"
git tag v1.2.0
git push origin main --tags
```

首次需要把本地仓库关联到 GitHub 远端（仓库已初始化 git 并打好 v1.2.0 标签）：

```bash
git remote add origin https://github.com/<你的账号>/<仓库名>.git
git branch -M main
git push -u origin main --tags
```

远端收到 tag 后，Actions 页面会出现「全平台发布构建」，约 10 分钟产出四份安装包并自动创建一个 GitHub Release（下载表格已按平台列好）。

工作流会在 Windows 与 macOS 两台运行环境并行构建，产出在 Actions 页面下载：

| 产物 | 说明 |
|------|------|
| `FluxGet-Setup-<版本>-x64.exe` | Windows 安装向导 |
| `FluxGet-Portable-<版本>-x64.exe` | Windows 便携单文件 |
| `FluxGet-<版本>-x64.dmg` | macOS Intel 芯片 |
| `FluxGet-<版本>-arm64.dmg` | macOS Apple 芯片 |
| `FluxGet-<版本>-x64.zip` / `-arm64.zip` | macOS 免安装压缩包 |

## 路径二：在 Mac 上本地构建

```bash
npm install
npm run dist:mac          # 一次产出 x64 + arm64 的 dmg 与 zip
npm run dist:mac:x64      # 只构建 Intel
npm run dist:mac:arm64    # 只构建 Apple 芯片
```

Windows 产物仍在本机执行 `npm run dist`。

## 发布前自检

```bash
npm run release:check
```

校验：版本号是否统一、四个核心产物是否齐全、图标与 entitlements 是否存在。缺哪项会直接列出。

## 代码签名（正式对外发布时）

当前配置 `identity: null`，产物未签名：

- **Windows**：首次运行触发 SmartScreen，需「更多信息 → 仍要运行」。购买代码签名证书后，在 electron-builder 配置中填入 `win.certificateFile` 与 `certificatePassword` 即可消除。
- **macOS**：未签名时用户需「右键 → 打开」绕过 Gatekeeper。有 Apple 开发者账号后：
  1. 安装 `npm i -D @electron/notarize`
  2. 在 `electron-builder.json` 的 `mac` 段去掉 `identity: null`，改为 `"identity": "Developer ID Application: XXX (TEAMID)"`
  3. 添加 `afterSign: "scripts/notarize.cjs"`，读取环境变量 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 调用 `@electron/notarize` 完成公证

## 平台差异说明

| 行为 | Windows | macOS |
|------|---------|-------|
| 关闭窗口 | 退出应用 | 隐藏窗口，Dock 常驻，Cmd+Q 退出 |
| 菜单栏 | 隐藏 | 提供应用菜单，Cmd+, 打开设置 |
| 任务提示 | 系统通知 | 系统通知 + Dock 角标显示进行中任务数 |
| 托盘图标 | 彩色图标 | 模板图标（系统按明暗模式着色） |
| 扩展安装 | chrome://extensions | 同为 chrome://extensions（Chrome / Edge 通用） |

## 版本历史

| 版本 | Windows | macOS |
|------|---------|-------|
| 1.1.0 | ✅ | ✅（Intel / Apple 芯片） |
| 1.2.0 | ✅ | ✅（Intel / Apple 芯片），随 Actions 同步产出 |

## CI 排障（已在 v1.2.0 首发时逐一踩过）

### 1. electron-builder 自己想发布，令牌没权限 → 403

推 tag 触发构建时，electron-builder 检测到 tag 会**自动尝试创建 GitHub Release**，而 Actions 的内置令牌默认没有 `contents: write`，于是：

```
• artifacts will be published  reason=tag is defined
⨯ HttpError: 403 Forbidden "Resource not accessible by integration"
```

**解法**：打包命令一律加 `--publish never`，产物只作为 workflow artifact 上传，Release 交给 `publish` 任务用 `softprops/action-gh-release` 创建（该任务单独声明 `permissions: contents: write`）。

### 2. macOS 上 npm 漏装平台二进制

npm 的 optional dependencies bug（[npm/cli#4828](https://github.com/npm/cli/issues/4828)）在 CI 上表现为：

```
Error: Cannot find module @rollup/rollup-darwin-arm64
⨯ Cannot find module 'dmg-license'
```

**两层防护**：

- `package.json` 的 `optionalDependencies` 显式列出 win32 / darwin / linux 各平台的 `@esbuild/*` 与 `@rollup/rollup-*` 版本（os 不匹配的会被 npm 自动跳过，互不影响）
- macOS 任务里加「补齐被 npm 漏装的可选依赖」步骤，逐个 `node -e "require(...)"` 探测，缺失才 `npm install --no-save`

### 3. 发布附件混入内部文件

`dist/*` 用 `*.exe` 这种宽泛 glob 会把 `win-unpacked` 里的 `FluxGet.exe`、`elevate.exe`、`esbuild.exe` 一起发上去。**必须按文件名精确匹配** `FluxGet-Setup-*.exe`、`FluxGet-Portable-*.exe`、`FluxGet-*-{x64,arm64}.{dmg,zip}`。

发布前先 `gh release delete <tag> -y` 清掉旧发布，避免残留资产累积。

### 4. 远程读不到构建日志怎么办

`GET /actions/jobs/{id}/logs` 需要仓库管理员权限，匿名 token 拿不到。本仓库内置了 `diagnose.yml`：以 `workflow_run` 的 `completed` 事件触发（**不能用 `if: failure()` + needs，那样会在运行还没结束时就取日志**），抓取失败步骤日志并自动建 issue。公开仓库可匿名读 issue，等于把日志"邮寄"出来。

## 发布排障

**`另一个程序正在使用此文件` / `remove ... app.asar` 失败**

上一版本目录中的 `win-unpacked/resources/app.asar` 被占用（多为杀毒软件实时扫描或残留进程）时，electron-builder 清空目录会失败，并留下残缺的 `win-unpacked`。排查与绕过：

1. 确认没有残留进程：`tasklist //FI "IMAGENAME eq FluxGet.exe"`
2. 若仍被占用，换输出目录重新构建，绕过锁：`npx electron-builder --win --x64 -c.directories.output="release/v<版本>"`
3. 构建前执行 `npm run release:check` 确认产物齐全，再对外发布
