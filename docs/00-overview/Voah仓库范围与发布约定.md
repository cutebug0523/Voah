# Voah 仓库范围与发布约定

## 1. 仓库

GitHub 账号：

```text
cutebug0523
```

仓库名：

```text
Voah
```

默认建议先建 private 仓库。确认发布策略后，再决定是否公开。

## 2. 应该进入 Git 的内容

```text
README.md
AGENTS.md
.gitignore
.env.example
docs/
scripts/
runtime/skills/voah-video-intake/
runtime/skills/voah-shot-retrieval/
cache/README.md
原片/README.md
口红/README.md
气垫/README.md
_research/README.md
ohmycrab/README.md
```

原则：

- 上传工程规则、架构、流程文档。
- 上传可复用脚本和后续桌面 worker 雏形。
- `runtime/skills/voah-video-intake/` 和 `runtime/skills/voah-shot-retrieval/` 是当前入库/召回链路的应急运行时 bundle，用于让干净机器不依赖 Codex/Crab harness 也能跑主流程。
- 上传轻量目录说明，保留本地目录语义。
- 上传 `.env.example`，只放变量名，不放真实 key。

## 3. 不进入 Git 的内容

```text
.env
cache/                    # 运行产物、模型返回、embedding、成片、音频
原片/                     # 原始素材
口红/                     # 历史素材目录
气垫/                     # 历史素材目录
GPT-SoVITS/               # 本地 TTS 环境和模型
_research/MoneyPrinterTurbo/
ohmycrab/*.json           # Crab 自动索引
*.mp4 / *.wav / *.mp3 / *.m4a 等媒体文件
```

原则：

- 不上传 API key。
- 不上传素材、成片、embedding、模型环境。
- 不上传本地安装的第三方大项目。
- 不上传 `.codex/skills` 或 `.agents/skills` 下的历史 skills。

## 4. Skills 的处理

历史 `voah-*` skills 是研发过程中的方法论和流程沉淀，不作为仓库运行入口上传。

当前例外：

```text
runtime/skills/voah-video-intake/
runtime/skills/voah-shot-retrieval/
```

这不是上传个人 `.codex/skills` 或 `.agents/skills` 目录，而是将已验证且当前代码真实调用的 skill scripts 作为 repo 内置运行时副本临时随仓库分发。默认入口仍是 `voah` CLI / `scripts/` worker：入库通过 `runtime/skills/voah-video-intake/scripts`，召回检索通过 `runtime/skills/voah-shot-retrieval/scripts/search.py`；后续稳定后再把这些脚本彻底 repo 化为一等 worker。

仓库里的真源应逐步转成：

```text
docs/       流程规格、schema、QA 规则
scripts/    可复用本地 worker
desktop/    后续 Electron 桌面应用
```

桌面版不直接调用 skills。员工操作层只调用固定流程和本地 worker。

## 5. 后续目录预留

桌面端开工后建议新增：

```text
desktop/
  package.json
  src/
  electron/
  workers/
```

Python worker 可以继续放在 `scripts/`，也可以在桌面应用稳定后迁到 `desktop/workers/`。

## 6. 上传前检查

每次上传前至少跑：

```bash
git status --short
git check-ignore -v .env cache 原片 GPT-SoVITS _research/MoneyPrinterTurbo ohmycrab/project-index.v2.json
rg -n 'sk-[A-Za-z0-9_-]+' README.md AGENTS.md docs scripts .env.example
```

其中 `rg` 只允许出现命令参数、普通英文词或误报，不能出现真实 API key。
