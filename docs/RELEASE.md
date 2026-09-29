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

## 发布排障

**`另一个程序正在使用此文件` / `remove ... app.asar` 失败**

上一版本目录中的 `win-unpacked/resources/app.asar` 被占用（多为杀毒软件实时扫描或残留进程）时，electron-builder 清空目录会失败，并留下残缺的 `win-unpacked`。排查与绕过：

1. 确认没有残留进程：`tasklist //FI "IMAGENAME eq FluxGet.exe"`
2. 若仍被占用，换输出目录重新构建，绕过锁：`npx electron-builder --win --x64 -c.directories.output="release/v<版本>"`
3. 构建前执行 `npm run release:check` 确认产物齐全，再对外发布
