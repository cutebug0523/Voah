#!/usr/bin/env bash
# 根目录转发器：在仓库根直接 ./dev.sh 即可拉起 voah-studio 桌面端。
# 真正的启动逻辑在 desktop/voah-studio/dev.sh。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT/desktop/voah-studio/dev.sh" "$@"
