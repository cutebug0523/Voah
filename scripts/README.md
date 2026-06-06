# Scripts 索引

`scripts/` 里放项目级本地 worker 和工具脚本。它们是后续桌面应用要调度的基础，不是一次性聊天脚本。

## 运行原则

- 脚本输入输出都走文件路径。
- 关键结果必须落盘，不能只打印终端。
- 输出 JSON 里尽量包含 `schema_version`、`inputs`、`outputs`、`qa`、`next_consumers`。
- API key 只从环境变量或本地私有配置读取，不写进脚本参数示例。
- 不主动启动常驻服务；需要服务时由用户或桌面应用显式管理。

## 当前脚本

### 视频理解

- `aliyun_qwen_omni_analyze.py`
  - 调用阿里百炼 Qwen-Omni 做视频理解验证。
  - 当前更偏早期探测脚本；正式入库逻辑以 `voah-video-intake` skill 和后续 worker 化脚本为准。

### TTS / 音频主轴

- `voah_run_oneshot_minimax_tts.py`
  - 读取 `voice_script.json`。
  - 调用 MiniMax 一次性 TTS。
  - 输出 `voice_minimax_oneshot.mp3`、`voice.wav`、`tts_audio.json`、`audio_sections.json`。

- `voah_assemble_segmented_tts.py`
  - legacy/回归工具。
  - 把分段 TTS 拼成统一 `voice.wav` 和音频主轴。
  - 主线优先使用一次性 TTS；该脚本保留用于对照和回退。

### 召回与时间线

- `voah_retrieve_fill_from_audio_sections.py`
  - 读取 `audio_sections.json` 和入库索引。
  - 按每段口播语义召回候选素材，并生成最终选片计划。
  - 默认不使用多模态 LLM；`selection_overrides.json` 只作为人工锁片输入。
  - 输出 `candidate_sections.json`、`timeline_selection.json`、`timeline_fill.json`、`preview_no_subtitles.mp4`。
  - 默认禁止 loop；素材不足时记录 `missing_duration_s` 并进入人工复核。

- `voah_fill_video_from_audio_sections.py`
  - legacy/回归工具。
  - 根据已有音频段和素材选择构造无字幕预览；默认不再 loop，短素材会进入人工复核。

### 字幕与 HyperFrames

- `voah_build_caption_plan.py`
  - 从 `audio_sections.json` 生成 `caption_plan.json`。
  - 字幕文本来自口播原文拆句。

- `voah_create_hyperframes_subtitle_project.py`
  - 从 `caption_plan.json` 创建 HyperFrames 字幕烧录工程。
  - 输出 `hyperframes_subtitle_burn/`。

### Manifest / QA

- `voah_write_full_pipeline_manifest.py`
  - 汇总任务目录里的核心产物、媒体探测和 QA。
  - 输出 `full_pipeline_manifest.json`。

## 当前主线脚本顺序

```text
voah_run_oneshot_minimax_tts.py
  -> voah_retrieve_fill_from_audio_sections.py
     -> candidate_sections.json
     -> timeline_selection.json
     -> timeline_fill.json
  -> voah_build_caption_plan.py
  -> voah_create_hyperframes_subtitle_project.py
  -> voah_write_full_pipeline_manifest.py
```

文案阶段目前仍主要由文档/skill 规则和人工校准承接，后续桌面化时应补稳定 worker。
