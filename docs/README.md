# Voah 文档索引

这个目录只放工程决策、方法论、调研和回归记录。运行产物放 `cache/`，脚本放 `scripts/`，原始素材放 `原片/` 或产品素材目录。

## 阅读顺序

新会话、干净 agent 或后续桌面应用开发前，先读：

1. `../AGENTS.md`
2. `../README.md`
3. `00-overview/Voah工程总览与管线.md`
4. `00-overview/Voah系列工程化底座.md`
5. 当前阶段对应目录下的文档

## 目录

```text
00-overview/              总览、工程底座、桌面应用方向
10-video-intake/          素材入库、视频理解、切分、向量化
20-copy-and-planning/     文案和素材编排策略
30-tts/                   TTS、音色、声音克隆、线上 API
40-subtitle-render/       字幕、硬字幕处理、HyperFrames 烧录
80-research/              外部项目调研和可借鉴设计
90-run-records/           历史测试、闭环记录、回归复盘
```

## 关键文档

### 总览

- `00-overview/Voah工程总览与管线.md`
- `00-overview/Voah系列工程化底座.md`
- `00-overview/Voah桌面应用架构.md`
- `00-overview/Voah桌面端生产工具MVP-PRD.md`
- `00-overview/Voah桌面应用模块与产物流转设计.md`
- `00-overview/Voah桌面应用数据模型与任务状态机.md`
- `00-overview/Voah桌面应用服务边界与Worker合同.md`
- `00-overview/Voah批量生产SOP与产能方案.md`
- `00-overview/Voah仓库范围与发布约定.md`
- `00-overview/混剪工作台技术方案.md`

### 素材入库

- `10-video-intake/Voah单素材分段方法论.md`
- `10-video-intake/视频理解方案-阿里百炼.md`
- `10-video-intake/阿里百炼Qwen-Omni视频理解接口笔记.md`
- `10-video-intake/视频向量化可复用项目调研.md`
- `10-video-intake/本地视频理解方案调研.md`

### 文案与编排

- `20-copy-and-planning/混剪编排策略-文案与素材顺序.md`

### TTS

- `30-tts/Voah-TTS线上API接入笔记.md`
- `30-tts/Voah-TTS声音克隆调研.md`

### 字幕与渲染

- `40-subtitle-render/字幕处理策略.md`
- `40-subtitle-render/硬字幕处理主流方案调研.md`
- `40-subtitle-render/Voah字幕样式与烧录记录.md`

### 调研与记录

- `80-research/MoneyPrinterTurbo对Voah的启发.md`
- `90-run-records/混剪闭环基线-rough-v1.md`
- `90-run-records/粗暴混剪测试记录.md`

## 当前主线

当前主线不是 agent 临场调用 skill，而是把已验证的方法固化成桌面应用里的本地流程：

```text
销售逻辑
  -> 连续口播
  -> MiniMax 一次性 TTS
  -> audio_sections
  -> 按口播语义召回/填充素材
  -> 口播原文拆句字幕
  -> HyperFrames 烧字幕
  -> QA / 导出
```

最近主线回归：

```text
../cache/voah_tasks/huaxizi-qidian/20260607_023341_selected6_full_pipeline_v1/
```

这轮使用 `原片/气垫/` 选 6 条素材，从入库、向量化、M3 文案、MiniMax TTS、按口播语义召回填充、HyperFrames 字幕烧录到最终 Omni 成片对齐 QA 全链路通过。

先读该目录下：

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

上一轮防晒气垫主线回归：

```text
../cache/voah_tasks/fangshai-qidian/20260605_202301_mainline_tts_semantic_v1/
```

先读该目录下：

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

## 文档维护规则

- 只记录工程结论、接口契约、调研证据和回归复盘。
- 不写 API key，不把 `.env` 内容复制进文档。
- 新阶段文档按目录归位，不再平铺到 `docs/` 根目录。
- 已废弃但有证据价值的方案放在 `90-run-records/` 或文档内标记 legacy。
- 新脚本要同步更新 `../scripts/README.md`。
- 新产物类型要同步更新 `../cache/README.md`。
