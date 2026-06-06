# Voah 混剪工作台

Voah 是当前项目里的带货混剪工程管线：素材入库、文案、TTS、素材召回、字幕、渲染和 QA 都按阶段产物承接。

当前方向已经从“靠 agent 调 skill 操作”转向“桌面应用固定流程”。Skills 继续作为方法论和 worker 合同来源，后续员工操作层应是 Electron 桌面应用，而不是让员工理解命令、路径和 skill。

新 agent、新会话或准备开发桌面版时先读：

1. `AGENTS.md`
2. `docs/README.md`
3. `docs/00-overview/Voah工程总览与管线.md`
4. `docs/00-overview/Voah系列工程化底座.md`
5. `docs/00-overview/Voah桌面应用架构.md`
6. `docs/00-overview/Voah桌面端生产工具MVP-PRD.md`
7. `docs/00-overview/Voah桌面应用模块与产物流转设计.md`
8. `docs/00-overview/Voah桌面应用数据模型与任务状态机.md`
9. `docs/00-overview/Voah桌面应用服务边界与Worker合同.md`
10. `docs/00-overview/Voah批量生产SOP与产能方案.md`
11. `docs/00-overview/Voah仓库范围与发布约定.md`

## 核心原则

- 始终使用简体中文。
- 不主动启动或停止服务，除非用户明确要求。
- 不把聊天上下文当工程状态；关键结果必须落盘。
- API key 不写进文档或 manifest，只放本地 `.env` 或私有配置。
- 每一步都要有输入、输出、QA 和下一步消费者。

## 主要目录

```text
docs/                  项目文档，入口见 docs/README.md
scripts/               项目级脚本和本地 worker，入口见 scripts/README.md
cache/                 本地运行产物，入口见 cache/README.md
原片/                  原始素材，入口见 原片/README.md
_research/             外部项目调研，入口见 _research/README.md
ohmycrab/              Crab 自动项目记忆，入口见 ohmycrab/README.md
口红/、气垫/           历史素材目录，保留原路径
GPT-SoVITS/            本地 TTS 回退环境，不作为当前主线默认 TTS
```

## 当前主线管线

```text
素材入库（常驻）
  -> 任务 brief / 产品全量卖点 / 平台目标
  -> 文案第一步：销售逻辑与脚本意图
  -> 文案第二步：连续口播稿
  -> MiniMax 一次性 TTS
  -> audio_sections
  -> 按口播语义召回/重打点/填充素材
  -> 字幕用口播原文断句
  -> HyperFrames 烧字幕
  -> 渲染 QA
```

## 已有 Voah Skills

```text
/Users/noah/.codex/skills/voah-video-intake/SKILL.md
/Users/noah/.codex/skills/voah-shot-retrieval/SKILL.md
/Users/noah/.codex/skills/voah-copy-brief/SKILL.md
/Users/noah/.codex/skills/voah-copy-final/SKILL.md
/Users/noah/.codex/skills/voah-tts/SKILL.md
```

## 关键文档

- `docs/README.md`
- `docs/00-overview/Voah工程总览与管线.md`
- `docs/00-overview/Voah系列工程化底座.md`
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
- `docs/40-subtitle-render/Voah字幕样式与烧录记录.md`

## 当前重要结论

- 入库是常驻层，单次任务从任务 brief、产品卖点和销售逻辑开始。
- `source_meaning` 是素材理解和后续文案对齐的核心资产。
- 主线不是先选 shot 再逐 shot 写稿；主线是先定全片销售逻辑，写连续口播，再 TTS。
- TTS 后按口播语义分段生成 `audio_sections.json`，再按每段语义召回/填充素材。
- 素材宜长不宜短；长素材可剪，短素材优先用同语义/同维度片段拼接，不默认用循环凑够。
- MiniMax/服务商粗字幕不能作为正式字幕时间源。
- 字幕文本来自 TTS 实际口播原文断句，字幕时间来自音频主轴或 forced alignment。
- 字幕样式用 HyperFrames，字体文件建议随工程保存。

## 最近主线回归

2026-06-07 用 `原片/气垫/` 选 6 条素材跑通当前桌面应用对齐后的主线闭环，并通过最终 Omni 成片对齐 QA：

```text
cache/voah_tasks/huaxizi-qidian/20260607_023341_selected6_full_pipeline_v1/
```

先读：

```text
full_pipeline_manifest.json
voice_script.json
audio_sections.json
timeline_fill.json
caption_plan.json
qa_omni_alignment_final/OMNI_ALIGNMENT_QA_REPORT.md
```

最终成片：

```text
hyperframes_subtitle_burn/final_subtitled.mp4
```

对应可用入库素材库：

```text
cache/voah_video_intake/huaxizi-qidian/20260607_013444_selected6_scene_candidates_v1/
```

2026-06-05 已从已有防晒气垫入库素材跑通过上一轮主线：

```text
cache/voah_tasks/fangshai-qidian/20260605_202301_mainline_tts_semantic_v1/
```

关键产物：

```text
RUN_PROCESS.md
full_pipeline_manifest.json
voice.wav
audio_sections.json
timeline_fill.json
caption_plan.json
preview_no_subtitles.mp4
hyperframes_subtitle_burn/final_subtitled.mp4
```

这轮确认的 TTS 基线：

```text
provider: minimax-official
model: speech-2.8-hd
voice_id: moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d
speed: 1.1
emotion: happy
voice_modify: pitch=20, intensity=20, timbre=0
```

对应可用入库素材库：

```text
cache/voah_video_intake/fangshai-qidian/20260603_225800_merged5_scene_candidates_v1/
```

历史 legacy 工具链回归仍保留：

```text
cache/voah_tasks/fangshai-qidian/20260605_175355_full_pipeline_regression_v1/
```

它证明 TTS、字幕、HyperFrames、manifest 可跑通，但不是当前主线范式。
