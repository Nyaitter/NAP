#!/usr/bin/env bash
# nap コマンドを使えるようにする。コマンド名で呼べるように PATH へ置く。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TARGET_DIR="${HOME}/.local/bin"
mkdir -p "$TARGET_DIR"

ln -sf "${SCRIPT_DIR}/nap" "${TARGET_DIR}/nap"
chmod +x "${TARGET_DIR}/nap"

echo "nap コマンドをインストールしました: ${TARGET_DIR}/nap"
case ":${PATH}:" in
  *":${TARGET_DIR}:"*) ;;
  *)
    echo "PATH に ${TARGET_DIR} を追加してください:"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac
echo "確認: nap --help"
