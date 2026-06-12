# Voah CLI 化生产内核方案

## 1. 结论

Voah 后续应采用 CLI-first 的生产内核。

这里的 CLI 化不是把员工操作层改成命令行，而是把真正的视频生产流程沉到稳定的 `voah` 命令层：

```text
voah CLI
  -> 调度 ffmpeg / ffprobe
  -> 调度 HyperFrames CLI
  -> 调度 Python worker
  -> 管理临时 OSS / 可访问资源
  -> 管理任务 manifest / 日志 / 失败重试 / QA gate
```

桌面端、批处理脚本、后续服务器或干净 agent 都只调用同一套 CLI。本文只定义 CLI 生产内核，不设计 Electron 前端。

## 1.1 真源头：5 个 voah skill

本方案不是凭空设计，它的真源头是已经在用的 5 个 voah skill：

```text
voah-video-intake    素材入库 + 结构化理解 + 向量化
voah-shot-retrieval  本地索引 + 多通道召回 + 时间线选片
voah-copy-brief      素材约束稿
voah-copy-final      最终口播稿
voah-tts             配音 + 时长 QA
```

skill 位置：`~/Library/Application Support/OhMyCrab/skills/voah-*`。

CLI 化的本质是把这 5 个 skill 沉淀的流程、产物合同和 QA 规则，固化成不依赖 agent 临场判断的 `voah` 命令。skill 与命令的映射：

```text
voah-video-intake    -> voah intake run
voah-shot-retrieval  -> voah retrieve run
voah-copy-brief      -> voah copy run (brief 阶段)
voah-copy-final      -> voah copy run (final 阶段)
voah-tts             -> voah tts run / voah tts preview
```

校准说明（方案与 skill / 生产脚本现状的已知偏差，详见 §11）：

- **顺序**：copy-brief / copy-final 这两个 skill 文档假设输入是 `slot_plan.json`（检索在前）。但真实生产脚本是 copy 在前：`voah_generate_copy_with_m3` 从 `task_brief.json` 出发产 `copy_brief.json` / `voice_script.json`，TTS 产 `audio_sections.json`，再由 `voah_retrieve_fill_from_audio_sections` 按音频段召回。本方案的主线（§5.7）采用生产脚本的 `copy -> tts -> retrieve`，`slot_plan` 路径降级为回归路径。
- **TTS provider**：`voah-tts` skill 文档写的是本地 GPT-SoVITS，但生产脚本用 MiniMax（oneshot 与 segmented 两种模式）。本方案以 MiniMax 为默认，provider 必须可配置（见 §5.3）。

## 2. 为什么改成 CLI-first

当前 Voah 的真实生产能力已经天然是命令式管线：

```text
ffprobe
ffmpeg
DashScope / Omni
Qwen3-VL-Embedding
MiniMax M3
MiniMax TTS
HyperFrames CLI
Python worker
JSON manifest
```

这些能力放在 CLI 层更顺：

- `ffmpeg`、`ffprobe`、HyperFrames 都是 CLI 友好工具。
- 临时 OSS 上传、URL 回收、header 处理、失败重试更适合统一由 CLI 管。
- 150 条/天的目标需要批量队列、并发、断点恢复和可复跑，不适合让 UI 层承担流程复杂度。
- 每一步都有明确输入、输出、QA、日志和下一步消费者，天然适合命令行阶段化执行。
- 新人仍然可以点桌面端，但桌面端只是提交任务和读取 manifest。
- 开发、调试、回归、自动化和后续服务器运行都能复用同一个生产入口。

## 3. 设计原则

### 3.1 CLI 是生产真源

CLI 负责业务流程编排和产物合同。

不允许出现两套生产逻辑：

```text
桌面端一套
CLI 一套
脚本临时一套
```

后续所有正式产物必须能追溯到某个 `voah` 命令和对应 manifest。

### 3.2 Worker 保持单阶段能力

Python worker 继续负责具体阶段：

```text
voah_intake_desktop_wrapper.py            入库总控
voah_generate_copy_with_m3.py             copy_brief + voice_script (MiniMax M3)
voah_run_oneshot_minimax_tts.py           TTS 一次性模式
voah_assemble_segmented_tts.py            TTS 分段合并模式
voah_retrieve_fill_from_audio_sections.py 按音频段召回 + 选片 + 预览
voah_fill_video_from_audio_sections.py    无召回直填(回归/降级)
voah_build_caption_plan.py                字幕方案
voah_create_hyperframes_subtitle_project.py 字幕工程
voah_burn_subtitles_overlay.py            字幕烧录(HyperFrames fallback)
voah_omni_alignment_qa.py                 Omni 对齐 QA
voah_write_full_pipeline_manifest.py      汇总 manifest
voah_build_desktop_quality_report.py      质量报告
voah_tts_desktop_preview.py               TTS 试听(不走全线)
```

CLI 负责串联、校验、日志、状态和重试。worker 不跨阶段做隐藏决策。

### 3.3 产物先于界面

每一步必须落盘，不能靠进程内变量或 UI 状态承接。

阶段产物必须包含：

```text
schema_version
inputs
outputs
qa
next_consumers
created_at
command
worker
status
```

### 3.4 Secret 不进入产物

API key 只从本机私有配置或环境变量读取。

禁止写入：

```text
README
docs
manifest
run log
GitHub issue
命令示例
```

产物里只允许记录：

```json
{
  "provider": "minimax-official",
  "key_configured": true
}
```

涉及外部 API 的请求/响应快照统一用 `*.safe.json` 命名（如 `minimax_oneshot_payload.safe.json`、`copy_llm_response.safe.json`、`llm_selection_plan.safe.json`）。`.safe.json` 约定：保留通信内容用于复盘，但写盘前必须剥除 key、token、签名 URL 凭证。这是现有生产脚本已落地的命名，CLI 要继续沿用并强制脱敏。

### 3.5 OSS 是 CLI 的一等资源

视频理解、向量化、Omni QA 都会遇到本地文件到模型 URL 的转换。

临时 OSS / 托管上传不能散落在各 worker 里临时拼。CLI 要提供统一资源层：

```text
本地文件
  -> voah resource upload
  -> resource_manifest.json
  -> worker 只读取 resource_id / resolved_url
```

## 4. 技术栈建议

### 4.1 CLI 总控

建议使用 Node.js 做 CLI 总控。

原因：

- 与现有 Electron / Node 方向一致。
- 调度外部进程、处理 JSON、管理并发、读写 manifest 很顺。
- 后续桌面端可直接调用同一个 Node package。
- 不需要把 Python worker 重写成 Node。

建议包名：

```text
voah
```

建议入口：

```text
cli/
  package.json
  src/
    bin/voah.ts
    commands/
    core/
    services/
    schemas/
```

第一版也可以先用 JavaScript，等命令边界稳定后再 TypeScript 化。

### 4.2 Python worker

Python 保留在 `scripts/`，继续做模型、音频、视频和字幕阶段的具体工作。

CLI 调用 Python worker 时必须统一传：

```text
--input-json
--output-dir
--run-id
--log-jsonl
```

旧 worker 短期可以兼容原参数，但 CLI 层应逐步收敛为统一合同。

### 4.3 外部工具

CLI 要统一检查：

```text
ffmpeg
ffprobe
python
node
hyperframes
dashscope   # OSS 上传 + Omni/embedding,入库与 QA 依赖
```

检查命令：

```bash
voah doctor
```

`doctor` 只检查工具、路径、模型 key 是否配置，不跑真实任务。

## 5. 命令设计

### 5.1 总览

```text
voah doctor
voah config get
voah config set
voah product create
voah product list
voah intake run
voah intake resume
voah intake qa
voah task create
voah task run
voah task resume
voah task inspect
voah copy run
voah tts run
voah tts preview
voah retrieve run
voah subtitle run
voah render run
voah qa run
voah batch run
voah resource upload
voah resource cleanup
```

命令可以先少做，但命名要从一开始稳定。

### 5.2 `voah doctor`

用途：

- 检查本机工具。
- 检查 Python 环境。
- 检查 HyperFrames 可用性。
- 检查私有 key 是否配置。
- 检查 workspace 目录。

示例：

```bash
voah doctor --workspace /Users/noah/混剪
```

输出：

```text
cache/voah_system/doctor/{timestamp}/doctor_report.json
```

### 5.3 `voah config`

用途：

- 管理本机私有配置。
- 不把 key 写入 repo。

建议配置路径：

```text
~/.voah/config.json
~/.voah/secrets.env
```

或后续接系统 keychain。

命令：

```bash
voah config get
voah config set minimax.api_key
voah config set dashscope.api_key
voah config set tts.provider minimax-official   # 默认 provider,可切 gpt-sovits
```

`get` 不输出真实 key，只输出是否存在。

### 5.4 `voah product`

用途：

- 维护产品库。
- 写文案时读取产品全量卖点、禁用表达、活动、CTA、平台目标。

命令：

```bash
voah product create --slug huaxizi-qidian --name 花西子气垫 --category 防晒气垫
voah product list
voah product inspect huaxizi-qidian
```

产物：

```text
data/products/{product_slug}/product.json
data/products/{product_slug}/claims.json
data/products/{product_slug}/campaigns.json
data/products/{product_slug}/blocked_terms.json
```

产品库不是素材入库产物，但会被 `copy run` 消费。

`product.json` 使用 `schema_version = "voah.product.v1"`，基础字段包括：

```json
{
  "slug": "huaxizi-qidian",
  "name": "花西子气垫",
  "brand": "花西子",
  "category": "防晒气垫",
  "cta": "点击下单"
}
```

`category` 是人工维护的产品品类信号。入库后的卖点提炼和任务文案 prompt 可以读取它，并使用“品类核心属性优先”的通用规则；代码和 prompt 不写死具体品类知识。

### 5.5 `voah intake run`

用途：

- 常驻素材入库。
- 从产品文件夹读取原片。
- 完成 ffprobe、候选切分、Omni story unit、物理裁切、OSS 上传、embedding、索引。

示例：

```bash
voah intake run \
  --product huaxizi-qidian \
  --source-dir /Users/noah/混剪/原片/气垫 \
  --limit 6 \
  --label selected6_scene_candidates_v1
```

输出：

```text
cache/voah_video_intake/{product_slug}/{timestamp}_{label}/
  run_manifest.json
  assets.json
  probes.json
  scene_segments_raw.json
  scene_segments_merged_1p2.json
  story_units.json
  shots.json
  physical_shots.json
  trimmed_physical/
  trim_upload_results_physical.json
  qa_last_frames.json
  qa_last_frames/
  contact_sheet.jpg
  vectorization_inputs.json
  embedding_results.json
  resource_manifest.json
  logs/
```

注：`resource_manifest.json` 是本方案新增的统一资源层产物（见 §6），现有入库脚本尚未生成，CLI 化时补齐。其余文件名以真实落盘为准。

要求：

- 产品身份优先来自 `--product` 和路径，不靠模型猜。
- 原片不进入 Git。
- 裁切必须遵守半开区间 `[start, end)`。
- `physical_shots.json` 必须记录 `trim_end_epsilon_s`、`clip_frames`、`clip_actual_duration_s`。
- `video_chunk` 必须是真视频 embedding，不得用文本 embedding 假代。

### 5.6 `voah task create`

用途：

- 创建单次成片任务。
- 写入任务 brief，但不立即运行。

示例：

```bash
voah task create \
  --product huaxizi-qidian \
  --intake-run cache/voah_video_intake/huaxizi-qidian/20260607_013444_selected6_scene_candidates_v1 \
  --target-duration 45 \
  --platform douyin \
  --label "45秒抖音投放版"
```

输出：

```text
cache/voah_tasks/{product_slug}/{timestamp}_{task_slug}/
  task_brief.json
  task_manifest.json
  logs/
```

`task_brief.json` 的 `product` 与 `product_library` 会带上产品库的 `category`。如果产品名和品牌为空，下游只能使用人工 `category` 生成泛称；不能从 slug 猜产品品类。

### 5.6.1 Task Worktree

单次任务的主目录只存稳定产物。每次运行创建独立 run workspace：

```text
task_dir/
  task_manifest.json
  .runs/
    {run_id}/
      run_manifest.json
      inputs/
      outputs/
      logs/
      work/
```

`run_id` 由 CLI 生成，格式为 `run_{timestamp}_{random}`。`run_manifest.json` 使用 `voah.task_run_manifest.v1`，必须记录：

- `task_dir`、`run_dir`、`output_dir`、`logs_dir`、`work_dir`
- `from_stage`、`stage`、`scope`
- `status`、`pid`、`started_at`、`updated_at`、`finished_at`
- `inputs.stable_artifacts`
- `stages`
- `outputs`
- `promotion`
- `error`

`run_manifest.json` 不允许写 API key、token、签名 URL 凭证。

旧任务没有 `.runs/` 时仍按主目录稳定产物读取；下一次 `task run` 或单阶段 `run` 会自动创建 `.runs/{run_id}`。

### 5.6.2 Promotion

worker 先写 `.runs/{run_id}/outputs`，只有阶段成功并通过 `requireStageOutputs` 基础校验后，才进入 promotion。

promotion 规则：

- promotion 是短锁临界区，只锁合入，不锁整条长任务。
- 文件/目录先复制到同目录临时路径，再 rename 到主目录。
- task manifest 原子写入。
- `task_manifest.runs.latest` 指向最后合入 run。
- `task_manifest.runs[{run_id}]` 记录 `promoted_paths` 和 `previous_active_artifacts`。
- 失败 run 保留在 `.runs/{run_id}`，主目录稳定产物不变。
- 如果更晚启动的 run 已经合入同阶段，较慢 run 标记 `superseded` 并停止继续往下跑。

当前优先迁移的重文件阶段：

- `retrieve`：`candidate_sections.json`、`timeline_selection.json`、`timeline_fill.json`、`preview_no_subtitles.mp4`
- `subtitle`：`caption_plan.json`、`hyperframes_subtitle_burn/`
- `render`：run 内 HyperFrames 工程与 `final_subtitled.mp4`
- `qa`：run 内 QA 报告，成功后再合入主目录

render 重试可以读取主目录稳定 `preview_no_subtitles.mp4` 和稳定 HyperFrames 工程，但不得直接覆盖主目录成片；所有中间文件先写 run workspace。

### 5.7 `voah task run`

用途：

- 单任务全流程。
- 从 `task_brief.json` 跑到最终成片和 QA。

示例：

```bash
voah task run cache/voah_tasks/huaxizi-qidian/20260609_050730_xxx
```

默认流程：

```text
copy
  -> tts
  -> retrieve
  -> caption
  -> render
  -> qa
  -> manifest
```

输出：

```text
copy_brief.json
voice_script.json
voice.wav
tts_audio.json
audio_sections.json
candidate_sections.json
llm_selection_plan.safe.json
timeline_selection.json
timeline_fill.json
preview_no_subtitles.mp4
caption_plan.json
hyperframes_subtitle_burn/
final_subtitled.mp4
qa_omni_alignment_final/
full_pipeline_manifest.json
```

真实任务目录还会落 `task_brief.json`、`*.safe.json` 通信快照、`qa_gate_report.json`、`desktop_quality_report.json/.md`、`export_record.json`,以及 `tts_segments/`、`timeline_fill_clips/`、`logs/` 等子目录。上表只列主线关键产物;CLI 应把这些辅助产物纳入 `task_manifest.json` 的指针管理。

### 5.8 阶段命令

单阶段复跑需要稳定命令。

```bash
voah copy run {task_dir}
voah tts run {task_dir}
voah retrieve run {task_dir}
voah subtitle run {task_dir}
voah render run {task_dir}
voah qa run {task_dir}
```

规则：

- 后续阶段发现上游 stale 时必须拒绝或提示 `--force-from`。
- 单阶段复跑创建新的 `.runs/{run_id}`，保留旧版本，不直接覆盖关键产物。
- 当前生效产物通过 `task_manifest.json` 的 artifact 指针确认。

retry / resume / continue 语义：

- `retry`：基于主 task_dir 的稳定上游产物，创建新 run，从指定阶段重跑。
- `continue`：从失败 run 推导可继续阶段，但输出仍写新 run；主目录只接受 promotion。
- `batch resume`：只调度 queued / failed / needs_review / stale，不重复启动 running task。
- `acknowledge`：只隐藏失败提醒，不改变 task 真状态。

### 5.9 `voah batch run`

用途：

- 批量生成多条成片。
- 面向一天 150 条的目标。

示例：

```bash
voah batch run \
  --product huaxizi-qidian \
  --intake-run cache/voah_video_intake/huaxizi-qidian/20260607_013444_selected6_scene_candidates_v1 \
  --count 20 \
  --target-duration 45 \
  --concurrency 3
```

输出：

```text
cache/voah_batches/{product_slug}/{timestamp}_{batch_slug}/
  batch_manifest.json
  tasks.json
  logs/
```

批量任务必须支持：

- 并发上限。
- 单条失败不阻塞全批。
- 失败重试。
- 复用已完成阶段。
- 汇总 QA。
- 导出合格成片清单。

## 6. 临时 OSS / Resource 层

> 现状：统一资源层与 `resource_manifest.json` 尚未落地。当前入库脚本各自用 dashscope CLI 上传并把 URL 记在 `trim_upload_results_*.json` 里。本节是 CLI 化时新建的合同。

### 6.1 目标

把本地文件变成模型可访问资源，并记录生命周期。

涉及阶段：

```text
Omni 视频理解
Qwen3-VL-Embedding 视频向量化
Omni 成片 QA
```

### 6.2 资源模型

```json
{
  "schema_version": "voah.resource.v1",
  "resource_id": "res_...",
  "local_path": "trimmed_physical/unit_xxx.mp4",
  "purpose": "omni_qa",
  "provider": "dashscope_managed_oss",
  "remote_url_present": true,
  "headers_required": {
    "X-DashScope-OssResourceResolve": "enable"
  },
  "created_at": "2026-06-10T00:00:00+08:00",
  "expires_at": null,
  "consumers": [
    "voah_omni_alignment_qa.py"
  ],
  "status": "ready"
}
```

注意：

- `remote_url` 可以写入本地 cache manifest，但不得进入 Git。
- 日志展示时默认脱敏。
- 资源消费方优先读 `resource_id`，不要各自重新上传。

### 6.3 命令

```bash
voah resource upload --file path/to/clip.mp4 --purpose omni_qa
voah resource cleanup --run cache/voah_tasks/... --expired-only
```

### 6.4 失败重试

资源层要区分：

```text
upload_failed
resolve_failed
access_denied
expired
provider_error
```

如果是 `access_denied`，CLI 应优先检查：

- OSS URL 是否完整。
- compatible API 是否带 `X-DashScope-OssResourceResolve: enable`。
- URL 是否被截断。
- resource manifest 是否 stale。

## 7. 任务状态机

> 现状：`task_manifest.json` 尚未落地,任务状态目前靠 `full_pipeline_manifest.json` 事后汇总兜底,缺少运行中的 stage 状态、attempt 与 artifact 指针。本节是 CLI 化时新建的合同,也是把"产物先于界面"真正立起来的关键。

### 7.1 Job 状态

```text
queued
running
succeeded
failed
blocked
cancelled
stale
```

### 7.2 Stage 状态

```text
pending
running
succeeded
failed
skipped
needs_review
stale
```

### 7.3 task_manifest

单任务目录必须有：

```text
task_manifest.json
```

建议结构：

```json
{
  "schema_version": "voah.task_manifest.v1",
  "task_id": "task_...",
  "product_slug": "huaxizi-qidian",
  "intake_run": "cache/voah_video_intake/...",
  "status": "running",
  "active_artifacts": {
    "voice_script": "voice_script.json",
    "voice": "voice.wav",
    "audio_sections": "audio_sections.json",
    "timeline_fill": "timeline_fill.json",
    "final_video": "hyperframes_subtitle_burn/final_subtitled.mp4"
  },
  "stages": {
    "copy": {
      "status": "succeeded",
      "attempt": 1,
      "started_at": "...",
      "finished_at": "...",
      "log": "logs/copy.jsonl"
    }
  },
  "qa": {
    "status": "pending"
  }
}
```

## 8. 日志与可观测性

每个命令都要写：

```text
logs/{stage}.jsonl
logs/{stage}.stdout.log
logs/{stage}.stderr.log
```

JSONL 每行建议：

```json
{
  "ts": "2026-06-10T00:00:00+08:00",
  "level": "info",
  "stage": "retrieve",
  "event": "candidate_pool_built",
  "data": {
    "section_count": 8,
    "candidate_count": 64
  }
}
```

原则：

- 给机器读 JSONL。
- 给人看摘要 Markdown。
- stderr 原样保留，但要避免打印 key。

## 9. 复跑策略

### 9.1 从某阶段重跑

示例：

```bash
voah task run {task_dir} --from retrieve
```

含义：

```text
保留 copy / tts / audio_sections
重跑 retrieve / subtitle / render / qa / manifest
```

### 9.2 stale 判断

如果上游文件 hash 变了，下游阶段标记 stale。

例：

```text
voice_script.json 变更
  -> tts stale
  -> audio_sections stale
  -> retrieve stale
  -> subtitle stale
  -> render stale
  -> qa stale
```

### 9.3 版本保留

重跑不直接覆盖历史关键文件。

建议：

```text
versions/
  voice_script/
    001_voice_script.json
    002_voice_script.json
```

当前生效版本由 `task_manifest.json.active_artifacts` 指向。

第一版可以先不实现完整版本目录，但文档合同要保留这个方向。

## 10. QA Gate

正式导出必须经过：

```text
结构化产物检查
媒体可读性检查
字幕/音频时长检查
素材时间线检查
Omni 对齐 QA
```

最终 `full_pipeline_manifest.json` 里必须写：

```json
{
  "export_gate": {
    "status": "pass",
    "checks": [
      "voice_exists",
      "audio_sections_match_voice_duration",
      "timeline_fill_no_loop",
      "caption_text_from_voice_script",
      "final_video_readable",
      "omni_alignment_ok"
    ]
  }
}
```

如果 Omni QA 失败，CLI 不应静默输出“可用成片”，而应标记：

```text
needs_review
```

并给出建议重跑入口：

```text
voah retrieve run {task_dir}
voah copy run {task_dir} --calibrate-from-qa
```

## 11. 与当前脚本的映射

### 11.1 入库

```text
voah intake run
  -> scripts/voah_intake_desktop_wrapper.py
  -> voah-video-intake skill 内现有 run_intake / trim / vectorize 逻辑
```

### 11.2 文案

```text
voah copy run
  -> scripts/voah_generate_copy_with_m3.py
  -> voah-copy-brief skill (copy_brief.json 合同)
  -> voah-copy-final skill (voice_script.json 合同)
```

注：生产脚本一次产出 copy_brief + voice_script；两个 copy skill 定义的是产物合同与 QA 规则，不是两个独立进程。

### 11.3 TTS

```text
voah tts run
  -> scripts/voah_run_oneshot_minimax_tts.py        (oneshot,默认)
  -> scripts/voah_assemble_segmented_tts.py         (segmented 合并模式)
voah tts preview
  -> scripts/voah_tts_desktop_preview.py
```

注：TTS 阶段同时产出 audio_sections.json,作为下游召回的音频主轴。

### 11.4 召回

```text
voah retrieve run
  -> scripts/voah_retrieve_fill_from_audio_sections.py   (带召回,主线)
  -> scripts/voah_fill_video_from_audio_sections.py      (无召回直填,降级)
```

注：`shot_index.json` 由召回阶段的建索引步骤(build_index)从入库产物构建,不是入库阶段产物。

### 11.5 字幕

```text
voah subtitle run
  -> scripts/voah_build_caption_plan.py
  -> scripts/voah_create_hyperframes_subtitle_project.py
```

### 11.6 渲染

```text
voah render run
  -> HyperFrames CLI
  -> scripts/voah_burn_subtitles_overlay.py 作为 fallback
```

### 11.7 QA

```text
voah qa run
  -> scripts/voah_omni_alignment_qa.py
  -> scripts/voah_write_full_pipeline_manifest.py
  -> scripts/voah_build_desktop_quality_report.py   (人读质量报告)
```

## 12. 第一版实施范围

### 12.1 V1 必做

- `voah doctor`
- `voah intake run`
- `voah task create`
- `voah task run`
- `voah task run --from`
- `voah tts preview`
- `voah qa run`
- 统一日志目录。
- 统一 `task_manifest.json`。
- 统一 `resource_manifest.json`。
- 统一读取本机 secrets。

### 12.2 V1 可缓

- 完整产品库 UI。
- 完整资源清理。
- 完整版本管理目录。
- 复杂队列暂停/恢复。
- 服务器部署。
- Electron 调用适配。

### 12.3 不做

- 不把 CLI 做成交互式问答工具。
- 不让 CLI 直接依赖 agent skill。
- 不把 API key 写进命令参数示例。
- 不把素材、cache、成片放进 Git。
- 不在 CLI 里重写所有 Python worker。

## 13. 推荐目录

```text
cli/
  package.json
  src/
    bin/
      voah.ts
    commands/
      doctor.ts
      config.ts
      product.ts
      intake.ts
      task.ts
      copy.ts
      tts.ts
      retrieve.ts
      subtitle.ts
      render.ts
      qa.ts
      batch.ts
      resource.ts
    core/
      paths.ts
      manifest.ts
      stageRunner.ts
      dependencyGraph.ts
      stale.ts
      logger.ts
    services/
      secretService.ts
      resourceService.ts
      workerRunner.ts
      toolchainService.ts
      artifactService.ts
    schemas/
      taskManifest.schema.json
      stageManifest.schema.json
      resourceManifest.schema.json
```

后续若与桌面端共享 Node 包，可以再调整成：

```text
packages/
  voah-cli/
  voah-core/
  voah-desktop/
```

第一版不需要为了 monorepo 提前复杂化。

## 14. 与桌面端的关系

本文不设计 Electron 页面。

但 CLI 的产物和状态需要天然可被桌面端消费：

```text
桌面端提交任务参数
  -> 调 voah CLI
  -> 监听日志 / 读取 task_manifest.json
  -> 展示状态、失败原因、产物路径和 QA 结果
```

桌面端不应该重新实现：

- OSS 上传。
- 任务状态机。
- worker 编排。
- stale 判断。
- QA gate。
- HyperFrames fallback。

如果后续前端由 Claude Code 实现，前端只需要对齐这些 CLI 命令和 JSON 产物。

## 15. 后续拆 issue 建议

如果进入实现，建议按以下 GitHub Issues 拆：

1. 搭建 `cli/` Node 命令骨架和 `voah doctor`。
2. 实现统一配置与 SecretService。
3. 实现 WorkerRunner、日志 JSONL 和阶段 manifest。
4. 实现 `voah intake run` 包装现有入库 worker。
5. 实现 `voah task create/run --from` 主线编排。
6. 实现 ResourceService 与临时 OSS manifest。
7. 实现 `voah batch run` 最小并发队列。
8. 将现有桌面端调度逻辑逐步改为调用 CLI。

其中第 8 项不属于本文范围，只作为后续集成提醒。
