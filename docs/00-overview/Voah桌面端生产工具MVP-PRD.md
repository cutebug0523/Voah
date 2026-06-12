# Voah 桌面端生产工具 MVP PRD

## 1. 背景

Voah 当前已经用 skills 和脚本验证了带货混剪主线：

```text
常驻素材入库
  -> 任务 brief
  -> 销售逻辑
  -> 连续口播
  -> TTS 音频主轴
  -> 按口播语义贴素材
  -> 字幕烧录
  -> QA / 导出
```

问题不在“能不能做出视频”，而在“不能靠 agent 一条条做”。Codex 类 agent 能跑出投放标准，但单条约 30 分钟，无法支撑一天 150 条的生产目标。

MVP 要把已验证的 SOP 固化成桌面工具：

```text
新人只点鼠标
系统跑固定流程
产物来源清楚
失败能重试
质量有硬门
```

## 2. 目标

V1 MVP 目标：

1. 新人打开桌面应用后，能看到产品、任务、待确认、失败和成品状态。
2. 能选择一个已入库产品，创建批量生产任务。
3. 系统用固定 job recipe 模拟并登记完整产物链。
4. 每个产物能说明来源：由哪个 job 生成、输入是什么、输出在哪里、QA 状态如何。
5. 失败态展示人话原因，并允许从失败步骤重试。
6. 最终成片是否可进入成品库，由 `qa_gate_report` 决定。

MVP 不追求：

- 不做权限系统。
- 不做管理员角色。
- 不做复杂素材库镜头管理。
- 不做正式视频算法重写。
- 不做完整多机分布式调度。
- 不把 API key 写入仓库或 manifest。

## 3. 用户

唯一日常用户：

```text
只会点鼠标的新手操作员
```

低频设置入口可以存在，但不作为角色体系出现。新手操作员不需要理解：

- skill 名。
- JSON 文件。
- cache 路径。
- ffmpeg / HyperFrames 命令。
- API key。
- embedding / OSS URL。
- 时间码。

## 4. 核心场景

### 4.1 查看工作台

用户打开应用后，首先看到：

```text
正在处理
待确认
失败待处理
可生产产品
最近成品
```

首页不是功能按钮宫格，也不是营销页。

### 4.2 产品可生产状态

用户能看到产品卡：

```text
产品名
素材状态
卖点状态
最近入库时间
可生产 / 需确认 / 阻断
```

产品素材没准备好时，不显示“开始混剪”主动作，只显示“处理素材”或“查看失败”。

### 4.3 创建批量任务

用户选择产品后，只填写业务信息：

```text
平台
目标时长
生成数量
主卖点
活动优惠
禁忌词
```

系统创建多个 TaskRun，并进入队列。

### 4.4 任务执行

任务按固定 recipe 运行：

```text
copy_brief
  -> voice_script
  -> tts_audio
  -> audio_sections
  -> timeline_fill
  -> caption_plan
  -> render_preview
  -> qa_gate
  -> export_record
```

MVP 可以使用 dry-run worker 模拟真实模型和媒体调用，但产物合同必须真实。

### 4.5 人工确认

用户只确认业务风险：

- 文案是否能投。
- TTS 是否自然。
- 无字幕预览是否画面对口播。
- 字幕是否遮挡或冲突。
- QA warning 是否接受。

### 4.6 失败重试

错误提示格式：

```text
任务：防晒气垫 45 秒投放版
失败步骤：语音生成
原因：TTS 服务超时
影响：还不能继续匹配素材
建议操作：重试语音生成
```

用户只有少数动作：

```text
重试失败步骤
取消任务
打开产物目录
```

## 5. 数据模型

MVP 必须实现最小数据对象：

```text
Product
TaskRun
JobRun
Artifact
QaGateReport
```

### 5.1 Product

记录：

```text
id
name
slug
source_folder
status
claim_summary
latest_intake_run
```

### 5.2 TaskRun

记录：

```text
id
product_id
title
status
target_platform
target_duration_s
created_at
updated_at
current_stage
```

状态：

```text
draft
queued
running
awaiting_review
qa_warning
completed
failed
```

### 5.3 JobRun

记录：

```text
id
task_id
stage
status
started_at
finished_at
retry_of_job_id
error_code
error_message
result_manifest_path
```

状态：

```text
queued
running
succeeded
warning
failed
stale
```

### 5.4 Artifact

记录：

```text
id
task_id
job_id
kind
path
source_artifact_ids
qa_status
created_at
```

所有关键产物必须有来源链。

### 5.5 QaGateReport

记录：

```text
id
task_id
status: pass / manual_review / block
checks[]
summary
created_at
```

## 6. 产物合同

每个 worker 输出的 JSON 至少包含：

```json
{
  "schema_version": "1.0.0",
  "stage": "voice_tts",
  "inputs": {},
  "outputs": {},
  "qa": {
    "status": "ok",
    "warnings": []
  },
  "next_consumers": []
}
```

MVP 需要生成的模拟产物：

```text
task_brief.json
copy_brief.json
voice_script.json
tts_audio.json
audio_sections.json
timeline_fill.json
caption_plan.json
qa_gate_report.json
export_record.json
```

## 7. 技术方案

技术栈：

```text
Electron + React + Vite
Electron Main / Node 本地调度
SQLite 或本地 JSON 存结构化状态
文件系统保存产物
Python worker 后续接入
ffmpeg / HyperFrames 后续接入
```

MVP 第一版可以用本地 JSON store 代替 SQLite，但代码结构必须保留迁移到 SQLite 的边界：

```text
ArtifactService
JobQueueService
WorkerRunner
VoahCliService
```

Renderer 不直接跑 worker，不直接写任意文件。

## 8. 页面范围

MVP 页面：

```text
工作台
产品
任务
成品
设置
```

### 工作台

展示：

- 状态概览。
- 运行中任务。
- 待确认任务。
- 失败任务。
- 可生产产品。
- 最近成品。

### 产品

展示：

- 产品卡。
- 素材可生产状态。
- 卖点摘要。
- 创建批量任务入口。

### 任务

展示：

- 任务阶段。
- Job 列表。
- 产物来源链。
- 失败重试。
- QA gate 状态。

### 成品

展示：

- 已完成任务。
- QA 状态。
- 导出记录。
- 打开产物目录。

### 设置

只放低频配置：

- workspace root。
- TTS voice preset。
- 字幕 preset。
- provider 是否已配置。

不做管理员角色。

## 9. MVP 验收标准

### PRD / Issues

- PRD 已落盘并纳入文档索引。
- GitHub Issues 已按功能切分。

### 功能

- 应用可以启动。
- 工作台能看到产品、任务、成品状态。
- 能创建批量任务。
- 任务能按 dry-run recipe 生成完整产物链。
- 失败任务能从失败步骤重试。
- 任务详情能展示 artifact 来源链。
- QA gate 能给出 `pass / manual_review / block`。

### 工程

- `npm run build` 通过。
- 核心服务有最小验证脚本。
- 不提交 `node_modules`、`dist`、cache、素材或 API key。

## 10. 后续非 MVP

- 接入真实 Python workers。
- 接入真实 MiniMax TTS。
- 接入真实素材召回和 HyperFrames 渲染。
- SQLite 正式 migration。
- 多生产 lane 压测。
- 150 条 / 天生产指标看板。
