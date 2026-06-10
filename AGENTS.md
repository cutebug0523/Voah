# AGENTS.md

## 基本原则

- 始终使用简体中文回答问题。
- 遵循最佳工程实践，优先维护可复用产物，而不是一次性脚本。
- 不主动启动或停止项目中的服务，除非用户明确要求。
- 不把 API key 写进文档、manifest、README 或代码注释。
- 不上传 `.codex/skills`、`.agents/skills`、素材、cache 产物、本地模型环境或外部调研源码。
- 运行命令前优先使用 `rg` / `rg --files` 搜索。
- 在中国大陆网络环境下，依赖安装、文档访问、CDN 选择优先考虑可用镜像。
- 当用户说“拆 issues”“拆 issue”“落 issues”时，默认含义是创建/整理 GitHub Issues，而不是只在本地 Markdown 写任务清单。
  - 如需先本地梳理，只能作为 issue 草案，并且要明确说明尚未落到 GitHub。
  - 创建 GitHub Issues 前先确认仓库范围；Voah 仓库范围遵循 `docs/00-overview/Voah仓库范围与发布约定.md`。
- 当用户要求“按 issues 开工/落地/实现”时，默认流程是：
  1. 先评估 GitHub Issues 之间的依赖关系，标出可并行、需串行、互相阻塞的部分。
  2. 对可并行的 issue 或子任务，优先拉子 agent / 独立线程处理，减少主线程上下文压力。
  3. 子 agent 的返回只是候选实现或分析，不等于完成；主 agent 必须做 review。
  4. review 必须覆盖代码质量、架构一致性、测试/构建结果、issue 需求与验收标准是否全量满足。
  5. 禁止“做了一部分就说完成”；只有 issue 的所有验收项都有证据证明通过，才算完成。
  6. 全量通过后，由主 agent 统一 commit、push，并关闭对应 GitHub Issues。
  7. 如某 issue 未全量通过，不得关闭；需说明缺口、阻塞或继续拆子任务。

## Voah 项目入口

新会话或干净 agent 先读：

1. `README.md`
2. `docs/README.md`
3. `docs/00-overview/Voah工程总览与管线.md`
4. `docs/00-overview/Voah系列工程化底座.md`
5. `docs/00-overview/Voah-CLI化生产内核方案.md`
6. `docs/00-overview/Voah批量生产SOP与产能方案.md`
7. `docs/00-overview/Voah桌面应用架构.md`
8. `docs/00-overview/Voah桌面端生产工具MVP-PRD.md`
9. `docs/00-overview/Voah桌面应用模块与产物流转设计.md`
10. `docs/00-overview/Voah桌面应用数据模型与任务状态机.md`
11. `docs/00-overview/Voah桌面应用服务边界与Worker合同.md`
12. `docs/00-overview/Voah仓库范围与发布约定.md`
13. 当前要执行阶段对应的 `voah-*` skill 或 worker 文档

## Voah 总管线

```text
voah CLI 生产内核
  -> 素材入库（常驻）
  -> 任务 brief / 产品全量卖点 / 平台目标
  -> 文案第一步：销售逻辑与脚本意图
  -> 文案第二步：连续口播稿
  -> TTS
  -> 按口播语义分段生成 audio_sections
  -> 按 audio_sections 召回/重打点/填充素材
  -> 字幕用口播原文断句并烧录
  -> 渲染 QA
```

## 产物约定

常驻素材库：

```text
cache/voah_video_intake/{product_slug}/{timestamp}_{run_label}/
```

单次任务：

```text
cache/voah_tasks/{product_slug}/{timestamp}_{task_slug}/
```

每一步必须落盘：

```text
inputs
outputs
qa
next_consumers
schema_version
```

不要只靠聊天上下文传状态。

## 当前 Voah Skills

```text
/Users/noah/.codex/skills/voah-video-intake/SKILL.md
/Users/noah/.codex/skills/voah-shot-retrieval/SKILL.md
/Users/noah/.codex/skills/voah-copy-brief/SKILL.md
/Users/noah/.codex/skills/voah-copy-final/SKILL.md
/Users/noah/.codex/skills/voah-tts/SKILL.md
```

## 阶段规则

- `voah-video-intake`：只做常驻入库，不写本次文案，不渲染成片。
- `voah-copy-brief`：先定全片销售逻辑、卖点顺序和 `script_sections` 意图，不绑定具体 shot。
- `voah-copy-final`：输出连续口播稿 `voice_script.json`；`full_voice_text` 是 TTS 和字幕文本真源。
- `voah-tts`：读取连续口播稿，输出 `voice.wav`、`tts_audio.json`、`audio_sections.json`。
- `voah-shot-retrieval`：默认在 TTS/audio_sections 之后按每段口播语义召回素材；旧的 `slot_plan -> 逐 shot 写稿` 只作为 legacy 回归路径。
- 素材填充阶段：按每段口播语义和时长选素材，素材宜长不宜短；长素材可裁，短素材优先找同语义/同维度片段拼接，避免只差一点点就循环凑。
- 字幕阶段：字幕文本必须来自 TTS 实际口播原文断句；不能用摘要版 `subtitle_text` 让声音和字幕各说各的。
- 后续正式生产逻辑应沉到 `voah` CLI；桌面版不直接调用 skills，也不重新实现复杂编排，只提交参数、调用 CLI、读取 manifest。
- skills 作为流程规格、schema 和 QA 约束；CLI 调固定本地 worker。

## 字幕与 TTS 特别注意

- 不要把 MiniMax `subtitle_file` 的粗分段当正式字幕时间源。
- 不要用 ASR 改写字幕文本；ASR/forced alignment 只能用来给已知文案找时间。
- 默认主线是：先写连续口播，TTS 后按口播语义分段，再用每段真实 duration 生成 `audio_sections.json`。
- 若已有 `*_raw.wav` 和被裁剪 `.wav`，优先用 `*_raw.wav` 作为时间源；激进 `silenceremove` 可能误裁短分段。
- 字幕样式用 HyperFrames；字体可换，但为了复刻，字体文件应复制进对应 HyperFrames 工程的 `fonts/`。

## 最近主线回归

2026-06-05 从已有防晒气垫入库素材跑通了一次当前主线闭环：

```text
cache/voah_tasks/fangshai-qidian/20260605_202301_mainline_tts_semantic_v1/
```

先读：

```text
RUN_PROCESS.md
full_pipeline_manifest.json
voice_script.json
audio_sections.json
timeline_fill.json
caption_plan.json
```

最终成片：

```text
hyperframes_subtitle_burn/final_subtitled.mp4
```

对应可用入库素材库：

```text
cache/voah_video_intake/fangshai-qidian/20260603_225800_merged5_scene_candidates_v1/
```

legacy 工具链回归：

```text
cache/voah_tasks/fangshai-qidian/20260605_175355_full_pipeline_regression_v1/
```

它能作为 TTS、字幕、HyperFrames 和 manifest 的工具链证据，不能作为 Voah 主线范式。主线仍是“连续口播/TTS 主轴 -> 按口播语义贴素材”。

## 重要文档目录

- `docs/README.md`
- `docs/00-overview/Voah工程总览与管线.md`
- `docs/00-overview/Voah系列工程化底座.md`
- `docs/00-overview/Voah-CLI化生产内核方案.md`
- `docs/00-overview/Voah桌面应用架构.md`
- `docs/00-overview/Voah桌面端生产工具MVP-PRD.md`
- `docs/00-overview/Voah桌面应用模块与产物流转设计.md`
- `docs/00-overview/Voah桌面应用数据模型与任务状态机.md`
- `docs/00-overview/Voah桌面应用服务边界与Worker合同.md`
- `docs/00-overview/Voah批量生产SOP与产能方案.md`
- `docs/00-overview/Voah仓库范围与发布约定.md`
- `docs/10-video-intake/Voah单素材分段方法论.md`
- `docs/20-copy-and-planning/混剪编排策略-文案与素材顺序.md`
- `docs/30-tts/Voah-TTS线上API接入笔记.md`
- `docs/30-tts/Voah-TTS声音克隆调研.md`
- `docs/40-subtitle-render/Voah字幕样式与烧录记录.md`
- `docs/40-subtitle-render/字幕处理策略.md`
- `docs/80-research/MoneyPrinterTurbo对Voah的启发.md`
