# Voah 桌面应用数据模型与任务状态机

## 1. 文档目的

这份文档只描述桌面应用的数据模型、任务状态机和产物注册方式，不写代码。

它承接：

- `Voah桌面应用架构.md`
- `Voah桌面应用模块与产物流转设计.md`

目标是让后续 Electron / Node 实现时，不再临时决定 SQLite 表、任务状态和产物依赖。

## 2. 核心对象

V1 桌面端最小核心对象：

```text
Workspace
Product
IntakeRun
TaskRun
Artifact
WorkerJob
QaReport
```

再往下细分：

```text
ProductClaim
Asset
StoryUnit
PhysicalShot
EmbeddingChannel
CopyVersion
TtsRun
AudioSection
TimelineItem
CaptionRun
RenderOutput
```

## 3. SQLite 表草案

### 3.1 workspaces

用途：

```text
记录当前 Voah workspace root 和运行环境。
```

字段：

```text
id
name
workspace_root
cache_root
created_at
updated_at
last_opened_at
```

### 3.2 settings

用途：

```text
记录非敏感配置。
```

字段：

```text
key
value_json
updated_at
```

注意：

- API key 不进 SQLite 明文字段。
- key 应放系统 keychain 或本机私有配置。

### 3.3 products

用途：

```text
产品主表。
```

字段：

```text
id
name
brand
slug
source_folder
status
created_at
updated_at
```

### 3.4 product_claims

用途：

```text
产品全量卖点、禁忌、CTA、活动信息。
```

字段：

```text
id
product_id
claim_type        # selling_point / proof / forbidden / cta / offer
title
body
priority
valid_from
valid_to
created_at
updated_at
```

### 3.5 intake_runs

用途：

```text
一次素材入库运行。
```

字段：

```text
id
product_id
run_label
run_dir
status
source_folder
manifest_path
asset_count
story_unit_count
physical_shot_count
embedding_channel_count
qa_status
created_at
started_at
finished_at
```

### 3.6 assets

用途：

```text
原始视频素材索引。
```

字段：

```text
id
product_id
intake_run_id
source_path
filename
duration_s
width
height
fps
has_audio
metadata_json
created_at
```

### 3.7 story_units

用途：

```text
语义/故事层素材单位。
```

字段：

```text
id
product_id
intake_run_id
asset_id
unit_key
start_s
end_s
duration_s
visual_summary
source_meaning
source_asr
source_ocr
hard_subtitle_risk
voiceover_fit
can_standalone
metadata_json
artifact_path
```

### 3.8 physical_shots

用途：

```text
物理裁切片段，可被二次裁切和时间线使用。
```

字段：

```text
id
product_id
intake_run_id
story_unit_id
asset_id
shot_key
source_start_s
source_end_s
usable_start_s
usable_end_s
duration_s
trimmed_path
qa_status
metadata_json
```

### 3.9 embedding_channels

用途：

```text
记录向量化通道，不直接把大 embedding 塞 SQLite。
```

字段：

```text
id
product_id
intake_run_id
target_type       # story_unit / physical_shot
target_id
channel           # video_chunk / visual_summary / source_meaning / asr / ocr / tags
model
dimension
embedding_ref     # embedding_results.json 内的引用
status
created_at
```

### 3.10 task_runs

用途：

```text
一次混剪任务。
```

字段：

```text
id
product_id
task_slug
task_dir
source_intake_run_id
status
target_duration_min_s
target_duration_max_s
platform
objective
manifest_path
created_at
started_at
finished_at
```

### 3.11 artifacts

用途：

```text
所有可被后续读取的产物登记表。
```

字段：

```text
id
scope_type        # intake_run / task_run / product / workspace
scope_id
stage
kind
path
schema_version
producer_job_id
content_hash
qa_status
created_at
updated_at
```

`artifacts` 是整个桌面端的中枢表。

### 3.12 artifact_dependencies

用途：

```text
记录产物之间的依赖，用于 stale 判断。
```

字段：

```text
artifact_id
depends_on_artifact_id
required
created_at
```

### 3.13 worker_jobs

用途：

```text
记录本地 worker 运行。
```

字段：

```text
id
stage
scope_type
scope_id
status
command_kind      # python / ffmpeg / hyperframes / node
command_display
started_at
finished_at
exit_code
stdout_path
stderr_path
result_manifest_path
error_code
error_message
retry_of_job_id
```

### 3.14 copy_versions

用途：

```text
文案版本。
```

字段：

```text
id
task_run_id
version
kind              # task_brief / copy_brief / voice_script
artifact_id
status
created_by        # model / human / import
created_at
notes
```

### 3.15 tts_runs

用途：

```text
TTS 运行与试听版本。
```

字段：

```text
id
task_run_id
voice_script_artifact_id
provider
model
voice_id
speed
emotion
voice_modify_json
voice_artifact_id
audio_sections_artifact_id
status
duration_s
created_at
```

### 3.16 audio_sections

用途：

```text
音频主轴分段，供素材召回和字幕使用。
```

字段：

```text
id
task_run_id
tts_run_id
section_index
role
voice_text
intention_copy
required_meaning
required_visual
start_s
end_s
duration_s
artifact_ref
```

### 3.17 timeline_items

用途：

```text
最终无字幕时间线条目。
```

字段：

```text
id
task_run_id
audio_section_id
item_index
source_physical_shot_id
source_path
source_start_s
source_end_s
timeline_start_s
timeline_end_s
duration_s
selection_reason
qa_status
```

### 3.18 caption_runs

用途：

```text
字幕计划版本。
```

字段：

```text
id
task_run_id
audio_sections_artifact_id
caption_plan_artifact_id
preset_id
status
caption_count
created_at
```

### 3.19 render_outputs

用途：

```text
最终渲染产物。
```

字段：

```text
id
task_run_id
timeline_artifact_id
caption_plan_artifact_id
output_path
duration_s
width
height
fps
status
created_at
```

### 3.20 qa_reports

用途：

```text
质量检查报告。
```

字段：

```text
id
scope_type
scope_id
target_artifact_id
status
warning_count
error_count
report_path
created_at
```

## 4. Artifact kind 枚举

建议 V1 先固定这些 kind：

```text
product_profile
product_claims
intake_manifest
assets
story_units
physical_shots
embedding_results
shot_index
task_brief
copy_brief
voice_script
tts_audio
voice_audio
audio_sections
candidate_sections
selection_overrides
timeline_fill
preview_no_subtitles
caption_plan
hyperframes_project
final_subtitled
qa_report
full_pipeline_manifest
```

每个 kind 要声明：

```text
producer
required_inputs
downstream_consumers
schema_version
stale_policy
```

## 5. Artifact stale 规则

一个产物变为 stale 的条件：

```text
上游 artifact content_hash 变化
上游 artifact 被人工替换
worker 参数变化
provider / model / voice / preset 变化
产品卖点或任务 brief 被标记为影响下游
```

典型例子：

```text
voice_script 变化
  -> tts_audio stale
  -> audio_sections stale
  -> timeline_fill stale
  -> caption_plan stale
  -> final_subtitled stale
  -> qa_report stale
```

```text
selection_overrides 变化
  -> timeline_fill stale
  -> preview_no_subtitles stale
  -> caption_plan 不一定 stale
  -> final_subtitled stale
  -> qa_report stale
```

```text
字幕 preset 变化
  -> caption_plan stale 或 render config stale
  -> final_subtitled stale
  -> qa_report stale
```

## 6. WorkerJob 状态机

状态：

```text
created
queued
running
awaiting_review
succeeded
warning
failed
cancelled
stale
```

允许流转：

```text
created -> queued
queued -> running
queued -> cancelled
running -> succeeded
running -> warning
running -> failed
running -> awaiting_review
running -> cancelled
awaiting_review -> queued
awaiting_review -> cancelled
succeeded -> stale
warning -> stale
failed -> queued
stale -> queued
```

禁止：

```text
failed -> succeeded
cancelled -> running
stale -> succeeded
```

失败重试必须创建新 job，并把 `retry_of_job_id` 指向旧 job。

## 7. TaskRun 状态机

TaskRun 不是单个 job，而是多个阶段的汇总。

状态：

```text
draft
ready
running
awaiting_review
rendered
qa_warning
completed
failed
archived
```

典型流转：

```text
draft
  -> ready
  -> running
  -> awaiting_review
  -> running
  -> rendered
  -> qa_warning
  -> completed
```

规则：

- 任意关键 job failed，TaskRun 可进入 `failed`。
- 如果失败阶段有上一个可用产物，TaskRun 可以保留 `awaiting_review`，让员工选择重试或回滚。
- 最终导出后进入 `completed`。
- 历史任务不删除，进入 `archived`。

## 8. IntakeRun 状态机

状态：

```text
draft
probing
segmenting
understanding
embedding
qa
ready
warning
failed
archived
```

入库阶段可以并发，但状态展示应合并：

```text
probing: ffprobe 多视频
segmenting: scene candidates / physical cuts
understanding: Omni / VLM
embedding: qwen3-vl-embedding
qa: 边界、末帧、字段完整性
```

入库 ready 之后才应该被任务层默认选用。

## 9. 目录与数据库同步

启动桌面应用时，建议执行轻量扫描：

```text
1. 读取 workspace root
2. 确认 cache/voah_video_intake 和 cache/voah_tasks
3. 扫描 manifest 文件
4. 对未登记产物做 import candidate
5. 不自动修改旧产物
```

导入规则：

- 有 `full_pipeline_manifest.json` 的 task run 可导入。
- 有 `run_manifest.json` 的 intake run 可导入。
- 缺 manifest 的目录只标为 legacy candidate，不直接进入主库。

## 10. 最小 migration 顺序

V1 第一批表：

```text
workspaces
settings
products
intake_runs
task_runs
artifacts
artifact_dependencies
worker_jobs
qa_reports
```

第二批表：

```text
product_claims
assets
story_units
physical_shots
embedding_channels
copy_versions
tts_runs
audio_sections
timeline_items
caption_runs
render_outputs
```

原因：

- 第一批先支撑应用启动、产物登记和任务运行。
- 第二批再把领域数据细化，避免一开始表太多但没有实际 UI/worker 消费。

## 11. 最小导入目标

第一版桌面端可以先导入这两个现有 run：

```text
cache/voah_video_intake/fangshai-qidian/20260603_225800_merged5_scene_candidates_v1/
cache/voah_tasks/fangshai-qidian/20260605_202301_mainline_tts_semantic_v1/
```

导入后应该能回答：

- 这个任务用了哪个产品。
- 这个任务用了哪个入库 run。
- 口播稿在哪里。
- 音频在哪里。
- 时间线在哪里。
- 字幕计划在哪里。
- 最终成片在哪里。
- QA warning 是什么。

## 12. 当前结论

桌面端的数据设计要以 `Artifact` 为中心，不以页面为中心。

最小可行底座：

```text
SQLite 记录状态和依赖
文件系统保存真实产物
ArtifactService 统一登记
WorkerJob 统一运行和失败恢复
TaskRun / IntakeRun 做业务层聚合
```

后续代码实现前，先实现 Artifact registry 和 worker job 状态机，比先做页面更重要。
