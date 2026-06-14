---
name: voah-video-intake
description: "视频素材入库管线：询问用户指定目标 → 文件夹推导产品身份 → ffprobe 元数据 → ffmpeg 视觉切点生成候选 scene_segments → Omni/VLM 只能按相邻候选段分组生成 story_units 与字段 → 半开区间物理裁切与末帧 QA → 物理片段上传 → 向量化（video_chunk 用原生 video embedding，文本通道用 text embedding）"
---

# Voah Video Intake

## Scope

视频混剪工作流的入库层：

```
user specifies target dir → video files → product metadata from path → ffprobe metadata → ffmpeg visual scene candidates → Omni groups adjacent candidates into story_units → layered records → optional physical shots inside story_units → half-open trim + QA → upload → vectorization
```

本 skill 负责素材入库和结构化理解，不负责最终剪辑/渲染。

## Core Decisions

1. **先问用户再扫**：Step 0 必须询问用户指定目标目录，不允许 Agent 自行猜测或扫描整个项目
2. 产品身份从文件夹结构推导，不由模型猜测
3. **视觉切点优先**：对拼贴型带货素材，先用 ffmpeg scene detection 生成候选视觉段；Omni 不自由发明裁切时间戳
4. **Omni 只做相邻候选段分组**：story_unit 的 start/end 必须来自候选 `scene_segments` 的边界
5. 保持层级：Asset → Story Segment → Story Unit → Shot → Moment
6. **Story Unit 是后续召回/时间线规划主单位**：Omni 判断哪些相邻候选段属于同人/同场景/同动作链/同卖点连续内容；换人、换场、换对象通常不合并
7. **区分 story unit、semantic highlight、physical shot**：`story_units.json` 是同一段/叙事段；`shots.json` 是 Omni 高光/语义证据点；`physical_shots.json` 是 story unit 内部需要更短使用时的干净视觉子单位
8. **Shot 级理解**：Omni 输出的每个 story_unit 和 highlight 必须包含 visual_summary、source_meaning、source_asr、source_ocr、hard_subtitle_risk、voiceover_fit、usable_start/usable_end、can_standalone
9. **video_chunk 必须是原生 video embedding**：裁切 physical shot 物理片段后上传 OSS，用 `{"video": trimmed_oss_url, "factor": 1.0}` 调用 `MultiModalEmbedding` 生成真视频向量，不是文本 label 的 embedding
10. **裁切使用半开区间**：`[start, end)`，默认 end 侧减 `1/fps`，并抽每段末帧 QA，避免末帧粘下一个镜头
11. 原始 copy 作为语义证据，不作为终稿

## Dependencies

- ffprobe（ffmpeg 附带）
- ffmpeg（物理裁切 shot 片段）
- dashscope Python CLI（pip install dashscope）
- DASHSCOPE_API_KEY（存储在 ~/.voah/video_intake/.env）
- 模型：Qwen3.5-Omni-Plus（视频理解）、Qwen3-VL-Embedding（向量化）

## 环境准备

API Key 保存在 `~/.voah/video_intake/.env`：
```
DASHSCOPE_API_KEY=...
```

如未设置，询问用户后使用脚本保存：
```bash
python3 runtime/skills/voah-video-intake/scripts/save_dashscope_key.py
```

dashscope CLI 路径：`~/Library/Python/3.9/bin/dashscope`

## Intake Workflow

### 0. Target — 询问用户指定目标路径（必须执行）

**在扫描视频文件之前，必须先向用户确认要入库的目标目录。**

Agent 必须使用 `AskUserQuestion` 或自然语言询问用户指定目标路径。用户可以提供：
- 项目内相对路径（如 `原片/防晒气垫`）
- 绝对路径
- 自然语言描述（如「气垫那个文件夹」「防晒相关的」）

Agent 根据用户输入定位到具体目录后，才能进入 Step 1。

**严格禁止**：Agent 不得自行假设目标目录、不得扫描整个项目、不得在用户未明确指定前执行任何 find/扫描操作。

### 1. Scan — 列出视频文件

基于 Step 0 确认的目标目录，使用 `find` / `rg --files` 列出视频文件（绝对路径），收集：路径、文件夹推导的产品元数据、文件名、文件大小

### 2. Probe — ffprobe 物理元数据
```bash
ffprobe -v quiet -print_format json -show_format -show_streams FILE
```
收集：时长、分辨率、fps、编码、音频流、旋转角度

### 3. Visual Candidates — 视觉候选段（边界真源）

短视频和拼贴型带货素材优先对整条原片做视觉切点检测：

```bash
ffmpeg -hide_banner -nostats -i FILE -vf "select='gt(scene,0.36)',showinfo" -an -f null -
```

默认参数：

- `scene_threshold=0.36`
- `candidate_min_duration=1.2`
- 小于阈值的碎段优先向后合并，避免污染前一段已经干净的结束边界

输出候选段：

- `scene_segments_raw.json`
- `scene_segments_merged_1p2.json`

每个候选段必须有 `id`、`start_s`、`end_s`、`duration_s`。后续 story_unit 边界必须来自这些候选段。

### 4. Understand — Omni/VLM 理解（含 story unit 与 shot 级字段）

使用 DashScope Qwen Omni 模型，传结构化 prompt 和 Step 3 的候选段列表，要求输出 JSON。

**强约束**：

- Omni 只能按候选段 ID 分组，不得自造 start/end
- 只允许合并相邻候选段
- story_unit 的 start/end 必须等于首尾候选段的 start/end
- 换人、换场、换对象、空镜到人物、真人到产品特写，一般不要合并
- 每个 story_unit 必须输出 `scene_segment_ids`

**Full-video 级字段**：
- visual_summary、source_ocr、source_asr、source_meaning
- selling_points、visual_actions、shot_type、timeline_roles
- product_evidence、hard_subtitle_risk、voiceover_fit
- usable_start / usable_end

**Story Unit 字段（后续主召回单位）**：
- `start` / `end`：同一段内容在源视频中的范围
- `label`：一句话概括
- `same_segment_reason`：为什么这些连续画面属于同一段
- `visual_summary`、`source_meaning`、`source_asr`、`source_ocr`
- `hard_subtitle_risk`、`voiceover_fit`
- `usable_start` / `usable_end`
- `can_standalone`
- `shot_type`、`selling_points`、`visual_actions`、`timeline_roles`、`editor_role`

**Shot 级字段（每个 highlight 必须包含）**：
- `visual_summary`：该 shot 的画面描述
- `source_meaning`：该 shot 传达的核心信息
- `source_asr`：该 shot 时间范围内的口播内容（如适用）
- `source_ocr`：该 shot 时间范围内的屏幕文字（如适用）
- `hard_subtitle_risk`：该 shot 的硬字幕风险（none/low/medium/high）
- `voiceover_fit`：该 shot 叠加新配音的适配度（excellent/good/fair/poor）
- `usable_start` / `usable_end`：该 shot 的最优可用区间（秒）
- `can_standalone`：该 shot 是否可独立成段（true/false）

**Prompt 模板参见** `references/shot-level-fields.md`。

### 5. Normalize — 分层记录
Asset → Story Segment → Story Unit → Shot → Moment

每个 Shot 必须包含 Omni 输出的 shot 级字段（visual_summary、source_meaning、source_asr、source_ocr、hard_subtitle_risk、voiceover_fit、usable_start、usable_end、can_standalone），不能只保留 Asset 级汇总。

这里的 `story_units.json` 是 **same-segment story units / 后续召回与时间线规划主单位**。
`shots.json` 是 **semantic highlights / 高光证据点**，不要求作为最终时间线主单位。

Normalize 时必须校验：

- `story_units[].scene_segment_ids` 存在
- 每个 story_unit 只包含相邻候选段
- start/end 回填为候选段边界
- 非候选边界不得进入后续裁切和向量化

参考实现：`scripts/normalize.py`

可直接使用入库 runner：

```bash
python3 scripts/run_intake.py \
  --target-dir /absolute/path/to/product_dir \
  --product "防晒气垫" \
  --product-slug fangshai-qidian \
  --run-label scene_candidates_v1 \
  --scene-threshold 0.36 \
  --candidate-min-duration 1.2 \
  --trim-story-units
```

### 5.25 Detect Cuts — Story Unit 内视觉切点细化

默认 story_unit 已来自 Step 3 的视觉候选边界。只有当 Omni 合并了多个候选段，或后续需要更短镜头时，才在 story unit 内部生成 `physical_shots.json`：

```bash
python3 scripts/detect_cuts.py --run-dir {run_dir}
```

输出：

- `scene_cuts.json`：每个 Asset 的全片视觉切点
- `physical_shots.json`：从 `story_units.json` 拆出的干净物理镜头，保留 `story_unit_id` / `parent_shot_id`

默认参数：

- `threshold=0.36`
- `min_duration=1.2`
- `edge_padding=0.25`

原则：

- ffmpeg scene detection 先负责“视觉边界在哪里”
- Omni 只决定“哪些相邻视觉段属于同一段内容”
- `story_units.json` 是后续召回/规划主单位
- `physical_shots.json` 是 story unit 内部的干净视觉镜头
- 后续裁切、上传、video_chunk embedding 默认使用 `physical_shots.json`
- 后续文案/时间线默认选 story unit，需要更短时再从其 `child_physical_shot_ids` 内取连续子段

### 5.5. Trim & Upload — 物理裁切并上传 shot 片段

对每个 physical shot，用 ffmpeg 从源视频裁切出物理片段，然后上传到 DashScope 临时 OSS：

```bash
# 默认精确裁切（重编码，边界更干净）
# duration_s = end_s - start_s - 1/fps，按半开区间 [start, end) 避免粘下一段首帧
ffmpeg -ss {start_s} -t {duration_s_minus_end_epsilon} -i {source_path} -c:v libx264 -preset veryfast -crf 18 -c:a aac -b:a 128k -avoid_negative_ts make_zero {output_clip}

# 上传到临时 OSS，模型名必须和后续调用模型一致
dashscope oss upload -f {output_clip} -m qwen3-vl-embedding
```

上传后获得 OSS URL，记录到 physical shot 的 `trimmed_oss_url` 字段，供 Vectorization 的 video_chunk 通道使用。

注意：DashScope CLI 可能把很长的 `oss://...mp4` 分成多行输出。脚本必须拼回完整 URL；如果 `oss_url` 太短、缺少视频文件扩展名或包含换行，不得进入向量化。

本地检查边界时可先不上传：

```bash
python3 scripts/trim_and_upload.py assets.json physical_shots.json trimmed_physical trim_upload_results_physical.json --no-upload
```

参考实现：`scripts/trim_and_upload.py`

失败恢复：如果裁切已完成但上传 URL 截断或过期，只重新上传 `trimmed_physical/*.mp4` 并回填 `physical_shots.json` / `trim_upload_results_physical.json`，不必重跑 Omni。

### 5.75 QA — 边界检查

每次入库必须至少生成或检查：

- `contact_sheet.jpg`：每个 story_unit 的代表帧总览
- `qa_last_frames/`：每个裁切片段的末帧
- `qa_last_frames.json`：末帧路径、帧数、实际时长

检查重点：

- 每段末帧不能明显是下一段首帧
- 相邻段如果视觉差异极低，可标记为 `low_visual_delta_boundary`，但不能误判为裁切粘帧
- 若仍粘帧，把 `end_epsilon` 从 `0.5/fps` 提高到 `1/fps`；当前默认使用 `1/fps`

### 6. Vectorization — 多通道嵌入

**关键区分**：

| 通道 | 嵌入方式 | 说明 |
|------|---------|------|
| `video_chunk` | `{"video": trimmed_oss_url, "factor": 1.0}` | **原生 video embedding**，对 Step 5.5 裁切的 physical shot 片段做视频向量 |
| `visual_summary` | `MultiModalEmbeddingItemText(text=...)` | 文本 embedding |
| `source_meaning` | `MultiModalEmbeddingItemText(text=...)` | 文本 embedding |
| `asr` | `MultiModalEmbeddingItemText(text=...)` | 文本 embedding |
| `ocr` | `MultiModalEmbeddingItemText(text=...)` | 文本 embedding |
| `tags` | `MultiModalEmbeddingItemText(text=...)` | 文本 embedding |

模型：`qwen3-vl-embedding`，API：`MultiModalEmbedding`，**输出维度：2560**。

**严格禁止**：video_chunk 通道不得使用 `MultiModalEmbeddingItemText`。video_chunk 必须是裁切后物理片段的原生视频 embedding。

参考实现：`scripts/vectorize.py`

## 输出目录

```
{workspace}/cache/voah_video_intake/{product_slug}/{YYYYMMDD_HHMMSS}_{run_label}/
```

产物：run_manifest.json, assets.json, segments.json, story_units.json, shots.json, physical_shots.json, moments.json, vectorization_inputs.json, embedding_results.json 等

## QA Checklist

- Step 0 已执行：目标目录由用户指定，非 Agent 猜测
- 产品身份来自路径/配置，非模型猜测
- ffprobe 数据完整
- 已生成 `scene_segments_raw.json` / `scene_segments_merged_*.json`
- Omni 只按相邻候选段分组，未自造时间戳
- 每个 story unit 的 `scene_segment_ids` 存在且连续
- 每个 segment 有 source_meaning
- 每个 story unit 有 visual_summary、source_meaning、same_segment_reason、时间范围、字幕/配音风险字段
- 每个 shot 有 shot 级 visual_summary、source_meaning（非仅 Asset 级汇总）
- 每个 shot 的 ASR/OCR 字段存在（可为空）
- 每个 shot 的 hard_subtitle_risk、voiceover_fit、usable_start/usable_end、can_standalone 已记录
- 每个 shot 已物理裁切并上传，trimmed_oss_url 已记录
- 裁切使用 `[start, end)` 半开区间，并记录 `trim_end_epsilon_s`
- 已抽末帧 QA，重点检查末帧不粘下一段首帧
- 默认规划粒度来自 `story_units.json`，不是 `physical_shots.json`
- 每个 physical shot 保留 `story_unit_id` / `parent_shot_id`
- video_chunk 通道使用 `{"video": trimmed_oss_url, "factor": 1.0}`（非 ItemText）
- `video_chunk.video_url` 必须是完整 `oss://...{video_ext}`，不能是 CLI 换行截断 URL
- 向量化维度为 2560（非 768）
- 复合 segment 保留子 shot 关系
- 向量化输入包含多通道
- 不假设粗窗口即最终切割
- 产物中不含 API key
