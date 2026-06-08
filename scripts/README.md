# Scripts 索引

`scripts/` 里放项目级本地 worker 和工具脚本。它们是后续桌面应用要调度的基础，不是一次性聊天脚本。

## 运行原则

- 脚本输入输出都走文件路径。
- 关键结果必须落盘，不能只打印终端。
- 输出 JSON 里尽量包含 `schema_version`、`inputs`、`outputs`、`qa`、`next_consumers`。
- API key 只从环境变量或本地私有配置读取，不写进脚本参数示例。
- 不主动启动常驻服务；需要服务时由用户或桌面应用显式管理。

## 当前脚本

### 素材入库

- `voah_intake_desktop_wrapper.py`
  - 桌面端可调用的素材入库 worker wrapper。
  - 读取产品名/slug、源素材目录、最多 N 条视频等参数，复用 `voah-video-intake` skill 自带的 `run_intake.py`、`trim_and_upload.py`、`vectorize.py`，不重写 Omni/裁切/向量化逻辑。
  - 输出 `cache/voah_video_intake/{product_slug}/{timestamp}_{run_label}/desktop_intake_result.json`，并补齐 `run_manifest.json`、`physical_shots.json`、`trimmed_physical/`、`vectorization_inputs.json`、`embedding_results.json`、`shot_index.json` 等桌面端/下游 worker 可读取产物。
  - 失败时也会尽量写出结构化 `desktop_intake_result.json`，便于桌面端登记 job 状态和日志路径。

### 视频理解

- `aliyun_qwen_omni_analyze.py`
  - 调用阿里百炼 Qwen-Omni 做视频理解验证。
  - 当前更偏早期探测脚本；正式入库逻辑以 `voah-video-intake` skill 和后续 worker 化脚本为准。

### TTS / 音频主轴

- `voah_generate_copy_with_m3.py`
  - 读取 `task_brief.json`。
  - 调用 MiniMax M3 生成 `copy_brief.json` 和 `voice_script.json`。
  - 只负责销售逻辑和连续口播，不绑定具体 shot。
  - `voice_script.full_voice_text` 是 TTS 与字幕文本真源。
  - 会读取 `shot_index.json` 汇总素材能力，把可见画面词分成 strong/high-evidence/weak；开头和产品段不得把弱证据词写成确定视觉诉求。
  - 会限制 `required_visual` 只能使用产品、粉扑、上脸、妆效、测试、陈列等可泛化画面需求，避免办公室、海边、车内等素材未证实硬场景词污染召回。
  - 当前会主动规避素材证据不足的“卡纹/泛油/油光/高浓度精华/奶油肌”等表达，改写成补妆、自然气色、轻薄服帖、自然柔焦等可由素材支撑的说法。

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
  - 默认使用文本 LLM MiniMax M3 在 embedding 候选池内选片；embedding 只负责粗召回，不直接等于最终选片。
  - worker 会读取本地 `.env` / `~/.voah/video_intake/.env` 注入 `MINIMAX_API_KEY` 和 `DASHSCOPE_API_KEY`，不把 key 写入产物。
  - `selection_overrides.json` 只作为人工锁片输入。
  - 输出 `candidate_sections.json`、`timeline_selection.json`、`timeline_fill.json`、`preview_no_subtitles.mp4`。
  - 默认禁止 loop；素材不足时记录 `missing_duration_s` 并进入人工复核。
  - 对 `parent_context_only` child，父级 context hit 只是弱证据；若 child 本身未验证硬画面词，会标记 `requires_visual_review`，等待 Omni 或人工复核。

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

- `voah_burn_subtitles_overlay.py`
  - HyperFrames render 超时或失败时的字幕烧录兜底。
  - 读取同一份 `caption_plan.json`，用 Pillow 生成透明字幕 PNG，再用 ffmpeg `overlay` 叠加到视频上。
  - 不依赖 ffmpeg `subtitles`、`ass` 或 `drawtext` 滤镜；字幕文本仍来自 `voice_script/audio_sections/caption_plan`，不会使用 ASR 或 MiniMax 字幕文本。

### Manifest / QA

- `voah_omni_alignment_qa.py`
  - 读取 `preview_no_subtitles.mp4` 或最终字幕视频、`audio_sections.json`、`timeline_fill.json`。
  - 按 audio section 裁切小视频，上传 DashScope OSS，调用 `qwen3.5-omni-plus` 检查音频/字幕/画面是否匹配。
  - DashScope compatible API 必须带 `X-DashScope-OssResourceResolve: enable`，并且 OSS URL 要使用多行拼接逻辑，避免截断导致 `Resource.AccessDenied`。
  - 输出 `qa_omni_alignment_*/omni_alignment_results.json` 和 `OMNI_ALIGNMENT_QA_REPORT.md`。
  - 最终字幕版 QA `status=ok` 时，可以把中间的 child visual-review warning 视为已复核 resolved。

- `voah_write_full_pipeline_manifest.py`
  - 汇总任务目录里的核心产物、媒体探测和 QA。
  - 输出 `full_pipeline_manifest.json`。
  - 会读取 `qa_omni_alignment_final/omni_alignment_results.json`；最终 Omni QA 通过时，中间 `child physical shot 未明确命中目标视觉词` warning 归入 `resolved_warnings`。

## 当前主线脚本顺序

```text
voah_generate_copy_with_m3.py
  -> voah_run_oneshot_minimax_tts.py
  -> voah_retrieve_fill_from_audio_sections.py
     -> candidate_sections.json
     -> timeline_selection.json
     -> timeline_fill.json
  -> voah_build_caption_plan.py
  -> voah_create_hyperframes_subtitle_project.py
  -> hyperframes render
     -> 若 HyperFrames 超时/失败，voah_burn_subtitles_overlay.py 兜底
  -> voah_omni_alignment_qa.py
  -> voah_write_full_pipeline_manifest.py
```

文案阶段允许在 Omni QA 后做一次结构化校准：只调整 `voice_script.json` 中口播与 `required_visual/required_meaning`，目标是让文案回到真实素材能支撑的范围；校准后必须从 TTS 重新往下跑。
