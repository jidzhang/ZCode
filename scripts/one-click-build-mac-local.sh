#!/usr/bin/env bash
# 一键本机编译打包 macOS 桌面安装包（macos12 分支，macOS 12 Intel x64）。
# 链路与 GitHub CI 的 build-mac job 语义一致：install → bundle.mjs build/pack。
# 产物输出到 packages/desktop/dist/。
#
# 网络说明（2026-11-08 实测定案）：electron-builder 的工具件下载走
# electron-builder-binaries release（7zip / dmgbuild-bundle / linux-tools-mac），
# 经内网代理下载会被截断/502（报 "Response code 502 Bad Gateway"，构建失败但
# DMG 可能已产出）。修复方式：electron-builder 26 在下载前会先查**归档缓存**
# <~/Library/Caches/electron-builder>/<releaseName>/<filename>，命中即跳过网络。
# 本脚本据此外层包装：
#   1. Electron 与 builder-binaries 全部走 npmmirror 直连（不需要代理）；
#   2. 首次运行用 curl 直连下载三个工具件（官方 sha256 校验）种进归档缓存。
# 之后重复构建完全离线可用。
#
# 用法：bash scripts/one-click-build-mac-local.sh
set -euo pipefail

cd "$(dirname "$0")/.."

NPM_EB_BINARIES="https://registry.npmmirror.com/-/binary/electron-builder-binaries"
EB_CACHE="$HOME/Library/Caches/electron-builder"

# electron-builder 工具件的官方 sha256（与 node_modules 内 app-builder-lib 一致）。
# 用「路径|校验和」行列表而非关联数组：macOS 自带 bash 3.2 不支持 declare -A。
TOOL_CHECKSUMS=(
  "7zip@1.0.0/7zip-darwin-x86_64.tar.gz|496a341abe210aae1a25bc202ee97f6de6c76a3dc80f91d96616be05502d72c1"
  "dmg-builder@1.2.5/dmgbuild-bundle-x86_64-75c8a6c.tar.gz|1664972f9cc2d6e8fce3b63e42cd30078aff602669c5856939c4519921200433"
  "linux-tools-mac@1.0.1/linux-tools-mac-darwin-x86_64.tar.gz|d62f5e2f6949c6420fdda8b18d2e70b0e14eeb959128c0cea11acada2c105ad9"
)

echo "==> [1/4] 预热 electron-builder 工具件归档缓存（npmmirror 直连，带 sha256 校验）"
for entry in "${TOOL_CHECKSUMS[@]}"; do
  rel="${entry%%|*}"
  expected="${entry##*|}"
  dest="$EB_CACHE/$rel"
  if [[ -f "$dest" ]] && echo "$expected  $dest" | shasum -a 256 -c - >/dev/null 2>&1; then
    echo "    [skip] $rel 已存在且校验通过"
  else
    mkdir -p "$(dirname "$dest")"
    echo "    [get ] $rel"
    curl -fsSL --retry 3 -o "$dest" "$NPM_EB_BINARIES/$rel"
    echo "$expected  $dest" | shasum -a 256 -c - >/dev/null
  fi
done

# Electron runtime zip：@electron/get 缓存，走 npmmirror（仓库默认 ELECTRON_MIRROR）。
# 无需额外处理；SHASUMS256.txt 直连 npmmirror 可达。

echo "==> [2/4] 安装依赖"
pnpm install --frozen-lockfile

echo "==> [3/4] 打包 mac x64（含运行时资产准备与生产构建）"
# 与 one-click-build-github-local.bat / release workflow 同口径：正式身份覆盖当前
# shell 可能残留的 test 环境；github 通道保证 macOS 12 不接收官方 macOS 13+ 更新。
export ZCODE_ENV=production
export ZCODE_PREVIEW_IDENTITY=0
export ZCODE_UPDATE_CHANNEL=github
export ZCODE_UPDATE_GITHUB_REPO="${ZCODE_UPDATE_GITHUB_REPO:-jidzhang/ZCode}"
export TURBO_TELEMETRY_DISABLED=1
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="$NPM_EB_BINARIES"
unset https_proxy http_proxy HTTPS_PROXY HTTP_PROXY || true
# desktop build 自带 prepare:runtime-assets；跳过 bundle 外层重复 prepare，
# 避免同一 Agent runtime 在一次一键构建里完整编译两遍。
node packages/desktop/scripts/bundle.mjs --os mac --arch x64 --skip-prepare

echo "==> [4/4] 完成。产物："
ls -lh packages/desktop/dist/ZCode-*-mac-x64.dmg packages/desktop/dist/ZCode-*-mac-x64.zip 2>/dev/null || \
  ls -lh packages/desktop/dist/
