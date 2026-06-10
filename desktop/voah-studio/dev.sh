#!/usr/bin/env bash
# Voah Studio 一键开发启动
# 自动处理这台机的已知坑：依赖安装、Electron 镜像、端口/僵尸进程清理、CLI 生产环境预检。
set -uo pipefail

STUDIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(cd "$STUDIO_DIR/../.." && pwd)"
CLI_ENTRY="$WORKSPACE/cli/src/bin/voah.js"
VITE_PORT=5174

# 国内镜像（与项目规范一致）
NPM_MIRROR="https://registry.npmmirror.com"
ELECTRON_MIRROR_URL="https://registry.npmmirror.com/-/binary/electron/"

c_reset=$'\033[0m'; c_dim=$'\033[2m'; c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_brand=$'\033[36m'
say()  { printf "%s▸ %s%s\n" "$c_brand" "$1" "$c_reset"; }
ok()   { printf "%s  ✓ %s%s\n" "$c_ok" "$1" "$c_reset"; }
warn() { printf "%s  ! %s%s\n" "$c_warn" "$1" "$c_reset"; }
die()  { printf "%s  ✗ %s%s\n" "$c_err" "$1" "$c_reset"; exit 1; }

cd "$STUDIO_DIR"

# 1) Node 版本
say "检查 Node"
command -v node >/dev/null || die "未找到 node，请先安装 Node 20+"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || die "Node 版本过低（需 ≥20，当前 $(node -v)）"
ok "node $(node -v)"

# 2) 依赖安装（含 Electron 二进制走淘宝镜像，绕开 GitHub 直连被代理拦）
say "检查依赖"
need_install=0
[ -d node_modules ] || need_install=1
[ -f node_modules/electron/path.txt ] || need_install=1
if [ "$need_install" = "1" ]; then
  warn "依赖不全，安装中（淘宝镜像）…"
  ELECTRON_MIRROR="$ELECTRON_MIRROR_URL" ELECTRON_CUSTOM_DIR='{{ version }}' \
    npm install --registry="$NPM_MIRROR" --no-audit || die "npm install 失败"
  # Electron 二进制偶尔在 postinstall 漏装，补一刀
  if [ ! -f node_modules/electron/path.txt ]; then
    warn "补装 Electron 二进制…"
    ( cd node_modules/electron && ELECTRON_MIRROR="$ELECTRON_MIRROR_URL" node install.js ) || die "Electron 二进制下载失败"
  fi
  ok "依赖就绪"
else
  ok "依赖已就绪"
fi

# 3) 清理上次没关干净的端口与僵尸 Electron（反复开发的隐性坑）
say "清理残留进程"
port_pid="$(lsof -ti tcp:$VITE_PORT 2>/dev/null || true)"
if [ -n "$port_pid" ]; then
  warn "端口 $VITE_PORT 被占用（pid $port_pid），回收"
  kill $port_pid 2>/dev/null || true
fi
pkill -f "voah-studio/node_modules/electron" 2>/dev/null && warn "清理旧 Electron 实例" || true
ok "环境干净"

# 4) CLI 生产环境预检（doctor）——能不能真生产，先探一遍，不阻塞启动
say "预检生产环境（voah doctor）"
if [ -f "$CLI_ENTRY" ]; then
  doctor_out="$(node "$CLI_ENTRY" doctor --workspace "$WORKSPACE" 2>&1 || true)"
  qa_line="$(printf '%s\n' "$doctor_out" | grep -E '^qa=' || true)"
  report_line="$(printf '%s\n' "$doctor_out" | grep -E '^doctor_report=' || true)"
  if printf '%s' "$qa_line" | grep -q 'qa=ok'; then
    ok "生产环境 OK（工具链 + 模型 key 齐备）"
  else
    warn "生产环境有缺项，批量出片可能失败。详见报告："
    printf "    %s%s%s\n" "$c_dim" "${report_line#doctor_report=}" "$c_reset"
    warn "可先在「设置」里补 key，或继续以只读方式浏览界面。"
  fi
else
  warn "未找到 voah CLI（$CLI_ENTRY），跳过预检"
fi

# 5) 拉起开发环境（Vite + Electron）
say "启动 Voah Studio"
echo "${c_dim}  Vite: http://localhost:$VITE_PORT  ·  Ctrl-C 退出${c_reset}"
exec npm run dev
