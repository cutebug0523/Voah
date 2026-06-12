<div align="center">

<h1>🎬 Voah</h1>

<b>CLI-first 带货短视频批量生产内核</b><br/>
<sub>素材入库 · 语义召回 · 文案 · 配音 · 字幕 · 渲染 · QA —— 一条命令，一天 150 条</sub>

<br/><br/>

<a href="./README.md">简体中文</a> ·
<a href="./README.en.md">English</a> ·
<a href="./README.ja.md">日本語</a>

<br/><br/>

![status](https://img.shields.io/badge/status-active-success)
![cli](https://img.shields.io/badge/CLI-Node.js%20%E2%89%A520-5FA04E?logo=node.js&logoColor=white)
![worker](https://img.shields.io/badge/worker-Python%203-3776AB?logo=python&logoColor=white)
![desktop](https://img.shields.io/badge/desktop-Electron%20%2B%20React-47848F?logo=electron&logoColor=white)
![ai](https://img.shields.io/badge/AI-Omni%20%C2%B7%20Embedding%20%C2%B7%20M3%20%C2%B7%20TTS-FF6F00)
![license](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## ✨ 这是什么

**Voah** 把带货短视频的整条生产流程，沉淀成一套稳定、可复跑、可观测的 `voah` 命令层。

不是"让 AI 帮你剪一条"，而是**工业化的批量生产内核**：每个素材被结构化入库、向量化、按语义精准召回；每条成片从文案、配音、选片、字幕到渲染、QA 全程落盘、可追溯、可断点重跑。桌面端只是壳——真正的生产能力在 CLI，命令行能跑通的，桌面端、批处理、服务器都能跑。

> 一条文案讲"倒水测试妆面不脱"，Voah 会从你的素材库里精准召回**真正在泼水的那一帧**，而不是一个看起来像的大头。

## 🧠 核心理念

| 原则 | 含义 |
|---|---|
| **CLI 是生产真源** | 所有业务逻辑在 `voah` 命令层，不存在第二套生产逻辑 |
| **产物先于界面** | 每一步落盘，不靠进程内变量或 UI 状态承接 |
| **可追溯 · 可复跑** | 每个产物记录 inputs/outputs/QA/下一步消费者，支持从任意阶段断点重跑 |
| **Secret 不进产物** | API key 只从本机私有配置读取，绝不写入 manifest/日志/示例 |
| **QA Gate 守门** | 默认做时长、碎帧、字幕同源、素材覆盖等本地校验；高成本 Omni 对齐需显式开启 |

## 🏗️ 生产管线

```mermaid
flowchart LR
    A[原片素材] --> B[intake 入库]
    B -->|ffprobe·切点·Omni理解·半开裁切·child细化·向量化| C[(shot_index<br/>语义索引)]
    C --> D[copy 文案]
    D --> E[tts 配音]
    E -->|audio_sections 音频主轴| F[retrieve 召回]
    F -->|多通道向量+M3精选+硬过滤| G[subtitle 字幕]
    G --> H[render 渲染]
    H --> I[qa 对齐校验]
    I --> J[✅ 成片]

    style C fill:#eef2ff,stroke:#6366f1
    style J fill:#dcfce7,stroke:#16a34a
```

**关键设计**：TTS 先定真实音频时长与分段，再按音频语义召回素材——时间线贴着配音主轴走，不会被后期配音长度打乱。

## 🎯 能力一览

- **🎞️ 素材入库**：ffmpeg 视觉切点 → Omni（Qwen3.5-Omni）story unit 理解 → child 级精细化 → 半开区间裁切（防碎帧）→ 原生视频向量化（Qwen3-VL-Embedding 2560 维）
- **🔍 语义召回**：多通道向量（视频/画面/语义/ASR/OCR/标签）粗召回 → MiniMax M3 精选 → required_visual 硬过滤 → child 级精准对位
- **✍️ 文案 + 配音**：MiniMax M3 写稿（字数→时长校准）→ MiniMax TTS（中文读法归一、营销数字处理）
- **🔥 字幕渲染**：HyperFrames 工程化字幕（动效/高亮）+ ffmpeg PNG 叠加兜底，像素级换行不溢出
- **🛡️ QA Gate**：时长、碎帧、字幕同源、素材覆盖等本地校验；需要时可用 `--run-omni` 追加 Omni 音画对齐
- **📦 批量队列**：并发上限、单条失败不阻塞、断点续跑、合格成片清单导出

## 🚀 快速开始

没有全局安装 `voah` 时，把下面命令里的 `voah` 替换成：

```bash
node cli/src/bin/voah.js
```

```bash
# 1. 环境自检（工具链 + 模型 key）
node cli/src/bin/voah.js doctor --workspace .

# 2. 素材入库
voah intake run --product my-product --source-dir ./原片/my-product --limit 3

# 3. 单条成片
voah task create --product my-product --intake-run <intake_dir> --target-duration 30
voah task run <task_dir>

# 4. 批量生产
voah batch run --product my-product --intake-run <intake_dir> --count 20 --concurrency 3
```

桌面端（Electron 工作台，给员工的低心智界面）：

```bash
./dev.sh
```

当前唯一桌面端是 `desktop/voah-studio`；历史实验壳已删除。桌面端只负责提交参数、展示 manifest/日志和调 CLI，不保留第二套生产编排。

## 📟 命令总览

```text
voah doctor                          环境自检
voah config get|set                  本机私有配置（key 不入库）
voah product create|list|inspect     产品库
voah intake run                      素材入库 + 结构化 + 向量化
voah task create|run [--from stage]  单任务全流程 / 断点重跑
voah copy|tts|retrieve|subtitle|render|qa run   单阶段复跑
voah tts preview                     配音试听
voah batch run|pause|resume          批量队列
voah resource upload|cleanup         临时 OSS 资源层
```

## 🧪 验证

```bash
cd cli && npm test
cd desktop/voah-studio && node --test test/voahService.test.js && npm run build
python3 -m unittest discover -s tests -p 'test_voah_*.py'
```

## 🧩 技术栈

| 层 | 技术 |
|---|---|
| CLI 总控 | Node.js（零依赖，≥20） |
| Worker | Python 3（17 个单阶段 worker） |
| 桌面端 | Electron + Vite + React 19 + Tailwind + zustand |
| 视频理解 | Qwen3.5-Omni-Plus |
| 向量化 / 召回 | Qwen3-VL-Embedding（2560 维原生视频向量） |
| 文案 / 选片 | MiniMax M3 |
| 配音 | MiniMax TTS |
| 字幕渲染 | HyperFrames + ffmpeg |

## 📂 仓库结构

```text
cli/        voah CLI（命令骨架 + 核心编排 + 服务层 + schema）
scripts/    Python worker（入库/文案/TTS/召回/字幕/渲染/QA）
desktop/    voah-studio 桌面工作台（Electron + React）
docs/       工程文档、设计方案、方法论
tests/      测试
```

开发者上手与工程文档见 [`docs/AGENTS-onboarding.md`](./docs/AGENTS-onboarding.md) 与 [`docs/README.md`](./docs/README.md)。

## 📄 License

[MIT](./LICENSE) © cutebug0523

<div align="center"><sub>Built for creators who ship at scale. 🚀</sub></div>
