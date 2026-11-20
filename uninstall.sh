#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/scripts/uninstall.mjs" ]; then
  node "$SCRIPT_DIR/scripts/uninstall.mjs" "$@"
else
  TARGET_DIR="${HOME}/.gemini/config/plugins/agy-monitor"
  if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
    rm -rf "$TARGET_DIR"
    echo "✓ 已卸载插件目录：$TARGET_DIR"
  else
    echo "未检测到已安装的插件目录：$TARGET_DIR"
  fi
fi
