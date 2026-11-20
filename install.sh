#!/usr/bin/env bash
set -euo pipefail

# AGY Console (agy-monitor) one-click installer for macOS / Linux
# Supports both:
#   1. Local install:  ./install.sh
#   2. Remote install: curl -fsSL https://raw.githubusercontent.com/aishadiaodeqishui/agy-monitor/main/install.sh | bash

REPO="${AGY_MONITOR_REPO:-aishadiaodeqishui/agy-monitor}"
BRANCH="${AGY_MONITOR_BRANCH:-main}"

echo ""
echo "========================================================"
echo "   AGY 控制台 (agy-monitor) 一键安装脚本"
echo "========================================================"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未检测到 Node.js，请先安装 Node.js >= 22.5.0 (https://nodejs.org) 后重试。"
  exit 1
fi

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)'; then
  echo "✗ 当前 Node.js 版本 $(node -v) 过低，需要 >= v22.5.0 (https://nodejs.org)。"
  exit 1
fi

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/plugin.json" ] && [ -f "$SCRIPT_DIR/scripts/install.mjs" ]; then
  node "$SCRIPT_DIR/scripts/install.mjs" "$@"
  exit 0
fi

# Remote pipe mode: download archive from GitHub and run installer
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ARCHIVE_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"
echo "正在从 GitHub 下载最新源码：${ARCHIVE_URL}"
curl -fsSL "$ARCHIVE_URL" -o "$TMP_DIR/repo.tar.gz"
tar -xzf "$TMP_DIR/repo.tar.gz" -C "$TMP_DIR"

EXTRACTED_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [ -z "$EXTRACTED_DIR" ] || [ ! -f "$EXTRACTED_DIR/scripts/install.mjs" ]; then
  echo "✗ 解压源码包失败，未找到 scripts/install.mjs。"
  exit 1
fi

node "$EXTRACTED_DIR/scripts/install.mjs" "$@"
