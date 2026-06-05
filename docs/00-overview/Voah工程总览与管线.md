# Voah 工程总览与管线

## 1. 定位

Voah 是一条可持续迭代的带货混剪工程管线，不是一次性脚本。

当前拆成两层：

```text
常驻素材库
  -> 单次混剪任务
```

常驻素材库负责理解、切分、向量化、索引素材。单次混剪任务从任务 brief 和销售逻辑开始，先产出连续口播与 TTS 音频主轴，再按口播语义召回、重打点和填充素材。

核心原则：

- 每一步必须有结构化产物。
- 每一步必须能说明输入来自哪里、输出给谁用。
- 聊天上下文不能作为唯一状态。
- 模型结果必须落盘，不能只打印到终端。
- 字幕、TTS、视频时间线都要以最终音频和任务产物为准，不信服务商粗字幕。

## 2. 当前目录约定

常驻入库产物：

```text
cache/voah_video_intake/{product_slug}/{timestamp}_{run_label}/
```

单次任务产物：

```text
cache/voah_tasks/{product_slug}/{timestamp}_{task_slug}/
```

项目文档：

```text
docs/
```

本地 Codex skills：

```text
/Users/noah/.codex/skills/voah-*/
```

## 3. 总流程

```text
素材入库（常驻）
  -> 任务 brief / 产品卖点 / 平台目标
  -> 文案第一步：全片销售逻辑与脚本意图
  -> 文案第二步：连续口播稿
  -> TTS：生成最终音频
  -> 按口播语义分段 audio_sections
  -> 按 audio_sections 召回/重打点/填充素材
  -> 字幕计划与样式
  -> HyperFrames/FFmpeg 渲染
  -> QA 与复盘
```

## 4. 阶段说明

### 4.1 素材入库：`voah-video-intake`

目标：

- 从产品文件夹读取原片。
- 产品身份优先来自路径/文件夹，不靠模型猜。
- ffprobe 读取物理元数据。
- ffmpeg scene detection 生成候选视觉切点。
- Omni/VLM 只按候选视觉段分组，生成 story units。
- 半开区间 `[start, end)` 裁切，避免末帧粘下个镜头。
- 物理片段上传后做原生 video embedding。
- 文本通道分别做 `visual_summary`、`source_meaning`、`asr`、`ocr`、`tags` embedding。

核心产物：

```text
assets.json
story_units.json
shots.json
physical_shots.json
trimmed_physical/
embedding_results.json
vectorization_inputs.json
run_manifest.json
```

关键字段：

```text
visual_summary
source_meaning
source_asr
source_ocr
hard_subtitle_risk
voiceover_fit
usable_start / usable_end
can_standalone
selling_points
timeline_roles
```

当前方法论详见：

- `../10-video-intake/Voah单素材分段方法论.md`
- `../10-video-intake/视频理解方案-阿里百炼.md`
- `../10-video-intake/阿里百炼Qwen-Omni视频理解接口笔记.md`

### 4.2 文案第一步：`voah-copy-brief`

目标：

- 读取任务 brief、产品全量卖点、平台目标、目标时长和风格。
- 先定全片销售逻辑：钩子、产品定位、卖点顺序、证明方式、福利/CTA。
- 生成用于后续召回的 `script_sections` / `intention_copy`，但不先绑定具体 shot。
- 保留素材库约束：产品必须匹配，后续每段都要能被素材 `source_meaning` 支撑。

核心产物：

```text
copy_brief.json
```

关键字段：

```text
product_claims
sales_logic
script_sections[].role
script_sections[].intention_copy
script_sections[].required_meaning
script_sections[].required_visual
script_sections[].avoid
target_duration_range_s
```

### 4.3 文案第二步：`voah-copy-final`

目标：

- 读取 `copy_brief.json`。
- 生成一条连续口播稿，而不是逐 shot 独立句子。
- 全片语气统一，语义顺序连贯，TTS 可直接读取。
- 字幕底稿默认来自口播原文断句，不做摘要改写。

核心产物：

```text
voice_script.json
```

关键字段：

```text
full_voice_text
pronounce_text
script_sections[].voice_text
script_sections[].intention_copy
script_sections[].required_meaning
subtitle_policy: verbatim_voice_text_split
target_duration_range_s
```

禁止：

```text
先选一排 shot，再给每个 shot 写一句独立口播。
让 subtitle_text 比 voice_text 更短更利落，导致声音和字幕对不上。
```

### 4.4 TTS：`voah-tts`

目标：

- 读取 `voice_script.json` 的连续口播文本。
- 做中文读法归一，例如 `SPF50+`、`PA+++`、`618`。
- 调用 MiniMax 官方 TTS、VectorEngine 兼容接口，或本地 GPT-SoVITS 回退。
- 输出最终音频和 TTS manifest。

核心产物：

```text
voice.wav
voice_minimax.mp3
tts_audio.json
pronounce_text.txt
```

当前线上基线：

```text
provider: minimax-official
model: speech-2.8-hd
voice: moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d
speed: 1.1
emotion: happy
voice_modify: pitch=20, intensity=20, timbre=0
```

注意：

- API key 只放 `.env` 或本地私有配置，不写入文档。
- VectorEngine 不能复用官方 MiniMax 账号下克隆的 voice_id。
- 旧版“一次性 TTS 后用 MiniMax 粗字幕拆 12 段”的方案不可靠。

### 4.5 音频主轴与语义分段

目标：

- 字幕和视频对齐围绕最终音频，而不是围绕服务商返回的粗字幕。
- 根据连续口播的语义段和 TTS 真实时长生成 `audio_sections.json`。
- 每个 section 是后续素材召回和字幕断句的真源。

推荐默认方案：

```text
voice_script.json
  -> TTS 生成 voice.wav
  -> 用 script_sections / 标点 / forced alignment 得到音频分段
  -> audio_sections.json
```

核心产物：

```text
audio_sections.json
```

注意：

- 如果为了稳定使用分段 TTS，也必须保证 `script_sections[].voice_text` 拼起来等于 `full_voice_text`，字幕文本仍按口播原文断句。
- 不要使用激进 `silenceremove` 作为默认步骤。2026-06-05 回归中，部分分段音频被误裁到不足 0.4 秒，最终改用 `*_raw.wav` 作为可信时间源。
- MiniMax `subtitle_file`、ASR、Whisper/FunASR 只能作为时间对齐线索，不能改写字幕文本。

### 4.6 召回、重打点与素材填充：`voah-shot-retrieval`

目标：

- 从已入库产物构建本地 `shot_index.json`。
- 对每个 `audio_sections[].intention_copy / voice_text / required_meaning` 做多通道召回。
- 产品名做 metadata filter。
- 默认以 `story_units` 作为主规划单位，`physical_shots` 作为子裁切单位。
- 用规则 rerank 守住产品、语义、卖点、时长、字幕风险、配音适配度。
- 用 Omni/VLM 或规则做 temporal rerank，输出真正可用的 start/end。

核心产物：

```text
shot_index.json
candidate_sections.json
timeline_fill.json
preview_no_subtitles.mp4
```

素材填充原则：

```text
素材宜长不宜短。
长素材可按 audio section 二次裁切。
短素材优先找同语义/同维度片段拼接。
不要因为“只差一点点”就默认循环凑够。
原素材音轨默认丢弃，只使用 voice.wav。
```

### 4.7 字幕计划与烧录

目标：

- 字幕文本来自 TTS 实际口播原文断句。
- 字幕时间来自 `audio_sections.json` 或 forced alignment。
- 字幕样式由 HyperFrames preset 管理。
- 关键词高亮批量生成，不逐句手写 span。

禁止：

```text
把 MiniMax subtitle_file 的 4 段粗时间当正式字幕时间源
把摘要版 subtitle_text 当口播字幕
```

核心产物：

```text
caption_plan.json
subtitle_presets.json
hyperframes_subtitle_burn_*/
subtitle_burn_manifest.json
preview_scheme*_subtitled.mp4
```

当前确认的两个字幕样式：

```text
songti_white_gold_lower
live_bar_lower
```

当前已知问题：

- `20260605_164301_minimax_voice_audio_master_v1/hyperframes_subtitle_burn_scheme1/preview_scheme1_subtitled.mp4` 使用了 MiniMax 4 段粗字幕外框，不应作为最终对齐范式。
- 该成片可看样式，不可作为字幕时间轴最佳实践。

### 4.8 Legacy 回归记录

2026-06-05 全链路回归产物证明了 TTS、ffmpeg 填视频、HyperFrames 字幕和 manifest 可以跑通，但该回归使用了 legacy 的 `slot_plan -> 逐 shot 写稿 -> TTS -> 填视频` 路径，不代表当前 Voah 主线范式。

回归路径：

```text
cache/voah_tasks/fangshai-qidian/20260605_175355_full_pipeline_regression_v1/full_pipeline_manifest.json
cache/voah_tasks/fangshai-qidian/20260605_175355_full_pipeline_regression_v1/hyperframes_subtitle_burn/final_subtitled.mp4
```

已知问题：

- 字幕用了摘要 `subtitle_text`，不是口播原文断句，导致声音和字幕不逐字对齐。
- 第 7、10 段素材短于音频，被循环兜底；主线应优先召回同语义片段拼接或换更长素材。
- 末段 `freezedetect` 报 0.73 秒静止，同样出现在源素材中，归类为源素材静帧风险。

字幕记录详见：

- `../40-subtitle-render/字幕处理策略.md`
- `../40-subtitle-render/硬字幕处理主流方案调研.md`
- `../40-subtitle-render/Voah字幕样式与烧录记录.md`

## 5. 当前 skills

已存在：

```text
/Users/noah/.codex/skills/voah-video-intake/SKILL.md
/Users/noah/.codex/skills/voah-shot-retrieval/SKILL.md
/Users/noah/.codex/skills/voah-copy-brief/SKILL.md
/Users/noah/.codex/skills/voah-copy-final/SKILL.md
/Users/noah/.codex/skills/voah-tts/SKILL.md
```

待补：

```text
voah-audio-axis
voah-timeline-fill
voah-subtitle
voah-render-qa
```

## 6. 当前关键结论

1. 入库是常驻层，不是每次任务的一部分。
2. 单次任务从任务 brief、产品卖点和销售逻辑开始，不从 `slot_plan.json` 开始。
3. `source_meaning` 是素材理解和后续召回对齐的核心资产。
4. 文案主线是先写连续口播，再 TTS，再按口播语义贴素材。
5. `slot_plan -> 逐 shot 文案` 是 legacy 回归路径，只能用于工具链测试。
6. TTS 之后必须让最终音频反过来确定字幕和视频时间轴。
7. MiniMax/服务商字幕只能作参考，不能当正式字幕时间真源。
8. 字幕文本必须来自 TTS 实际口播原文断句。
9. 字幕样式可用 HyperFrames 管，字体要随工程保存才能复刻。
10. 每一步必须有 manifest、QA、next_consumers。

## 7. 入口文档

建议新 agent 先读：

1. `AGENTS.md`
2. `README.md`
3. `docs/README.md`
4. `docs/00-overview/Voah工程总览与管线.md`
5. `docs/00-overview/Voah系列工程化底座.md`
6. `docs/00-overview/Voah桌面应用架构.md`
7. 具体阶段对应的 skill `SKILL.md` 或 worker 文档
