# 多设备开发：Windows 本机 + Mac 协同

代码以 GitHub 仓库为唯一交换中心，两台机器各写各的平台特产，互不干扰。

```
        ┌──────────── Windows 本机 ────────────┐
        │  开发 / 调试 / 打 Windows 包          │
        └───────────────┬──────────────────────┘
                        │  git push / pull
                ┌───────▼────────┐
                │  GitHub 仓库   │  ← 唯一真源
                └───────▲────────┘
                        │  git push / pull
        ┌───────────────┴──────────────────────┐
        │  Mac 电脑                            │
        │  开发 / 调试 / 打 macOS 包            │
        └──────────────────────────────────────┘
```

分工原则：**改哪边的东西就在哪台机器上验证**。跨平台通用代码（引擎、界面、桥接）两台都行；只在一个平台跑得起来的（打包、签名、平台专属行为）必须在对应机器上做。

## Mac 首次搭建

在 Mac 上打开「终端」，逐行执行：

```bash
# 1. 克隆仓库（选一处你喜欢的位置，比如 ~/Developer）
mkdir -p ~/Developer && cd ~/Developer
git clone https://github.com/wxinhappy/FluxGet.git
cd FluxGet

# 2. 配置身份（每台机器只需一次）
git config user.name "FluxGet Dev"
git config user.email "dev@fluxget.local"

# 3. 安装依赖
npm install

# 4. 开发模式跑起来
npm start
```

> Mac 上 `github.com` 是通的，直接用 HTTPS 即可，**不需要配 SSH**。

如果第 4 步报 `Cannot find module @rollup/rollup-darwin-arm64`（npm 可选依赖的已知 bug），补一句：

```bash
npm install --no-save @rollup/rollup-darwin-arm64@4.63.5 @esbuild/darwin-arm64@0.21.5 dmg-license@1.0.11
```

## 两台机器上的常用命令

| 想做的事 | Windows 本机 | Mac |
|---------|-------------|-----|
| 拉最新代码 | `git pull` | `git pull` |
| 开发模式运行 | `npm start` | `npm start` |
| 类型检查 | `npm run typecheck` | `npm run typecheck` |
| 打本机平台的包 | `npm run dist` | `npm run dist:mac` |
| 只打 Intel 的包 | — | `npm run dist:mac:x64` |
| 只打 Apple 芯片的包 | — | `npm run dist:mac:arm64` |
| 跑引擎测试 | `npm run test:engine` | `npm run test:engine` |
| 跑桥接测试 | `npm run test:bridge` | `npm run test:bridge` |

## 每天开工和收工

**开工前**先拉最新代码，避免基于旧版本改：

```bash
git pull
```

**收工前**提交并推送，另一台机器第二天才能拿到：

```bash
npm run typecheck          # 提交前必跑，避免把类型错误推上去
git add -A
git commit -m "说明这次改了什么"
git push
```

## 避免冲突的约定

- **一次只在一台机器上改**。要换机器前，先把当前改动 `git push` 上去。
- 换到另一台机器后第一件事是 `git pull`。
- 改了版本号后跑一次 `npm run version:sync`，让扩展 manifest 跟着走。
- `release/`、`out/`、`node_modules/`、`.tmp/` 都在 `.gitignore` 里，**不要把构建产物提交上去**。
- 两台机器都不要手改 `package-lock.json`，改依赖请用 `npm install <包名>` 让它自己更新。

如果真起了冲突（两边改了同一文件的同一处），先 `git pull`，打开冲突文件，删掉 `<<<<<<<` / `=======` / `>>>>>>>` 标记留下正确的内容，再 `git add` + `git commit`。

## 关于行尾

仓库根目录放了 `.gitattributes`，强制文本文件在仓库里统一存 LF。Windows 上检出还是 LF（现代编辑器都支持），Mac 上天然一致，两边不会再互相刷出「整文件都被改过」的假 diff。

## 发布

发布流程不变：推 `v*` 标签后由 GitHub Actions 同时打出四个包，本机不必参与。发版前先跑一次自检：

```bash
npm run release:check
```

详见 `docs/RELEASE.md`。
