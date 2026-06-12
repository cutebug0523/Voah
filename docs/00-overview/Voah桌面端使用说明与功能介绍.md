# Voah 桌面端使用说明与功能介绍

## 1. 当前进度

截至 2026-06-09，Voah 桌面端已经从“agent 调 skill 的实验流程”推进到“Electron + React + Node 本地调度”的可操作生产工作台。

已经完成：

- 桌面端壳子：Electron + React + Vite。
- 本地状态库：产品、任务、步骤、产物、QA 报告和设置都落在本机 JSON store。
- 模型 Key 设置：界面只填 key，模型名、URL、endpoint 固定在模型注册表里。
- 产品与批量任务：选择可生产产品，填写平台、目标时长、数量、主卖点、活动优惠、禁忌、风格、受众、CTA，然后一键创建并运行。
- 真实主线生产 recipe：任务 brief、销售逻辑、连续口播、MiniMax TTS、audio_sections、素材召回/选片、视频填充、字幕计划、HyperFrames 字幕烧录、QA gate、导出记录。
- 生产参数配置：文案默认参数、TTS 音色与声音参数、字幕 preset 与字体路径可在设置页维护；创建任务时会保存一份快照。
- 页面收口：工作台、产品、任务、成品、设置页面已经按 Electron 视口做过基础排版收敛，长路径/长标题不会把布局顶飞。

已经验证过的主线产物：

```text
cache/voah_tasks/huaxizi-qidian/20260607_023341_selected6_full_pipeline_v1/
```

最终成片：

```text
cache/voah_tasks/huaxizi-qidian/20260607_023341_selected6_full_pipeline_v1/hyperframes_subtitle_burn/final_subtitled.mp4
```

当前仍未完整产品化：

- 产品页已支持新增/编辑产品字段、维护卖点/合规/CTA/默认活动，并可触发素材入库 job。
- 素材入库 job 会调用固定 worker 跑 Omni 理解、切分、上传、向量化和本地 `shot_index` 构建；当前入库失败重试仍以重新点击处理素材为主。
- 成片 QA 已有 gate 和产物记录，但人工审核、批量导出和返工策略还可以继续细化。
- 视频去字幕模块只应作为后续占位能力，还没有进入当前主线。

## 2. 启动方式

项目目录：

```text
/Users/noah/混剪/desktop/voah-studio
```

开发模式：

```bash
cd /Users/noah/混剪/desktop/voah-studio
npm run dev
```

浏览器调试模式：

```bash
cd /Users/noah/混剪/desktop/voah-studio
npm run dev:vite
```

然后打开：

```text
http://127.0.0.1:5174/
```

注意：

- `npm run dev` 会同时启动 Vite 和 Electron。
- 正式本地操作优先用 Electron。
- API key 不写入仓库；桌面端会读本机私有配置。

## 3. 基础操作流程

### 3.1 先检查设置

进入「设置」页。

模型 Key 区域会显示这些模块：

- 素材理解 / `qwen3.5-omni-plus`
- 素材向量化 / `qwen3-vl-embedding`
- 素材召回 / `qwen3-vl-embedding`
- 文案生成 / `MiniMax-M3`
- 选片计划 / `MiniMax-M3`
- TTS / `speech-2.8-hd`
- TTS备用 / `speech-2.8-hd`

如果 key 已配置，会显示“已配置”和脱敏 key。没有配置时，在输入框填入对应 key 后点保存。

生产默认参数区域包含：

- 文案：默认风格、默认受众、默认活动、违禁/禁忌、CTA 规则。
- TTS：音色、模型、情绪、语速、音量、音调、`pitch`、`intensity`、`timbre`。
- 字幕：字幕样式、字体文件、是否按标点拆字幕。

当前默认 TTS 基线：

```text
provider: minimax-official
model: speech-2.8-hd
voice_id: moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d
speed: 1.1
emotion: happy
voice_modify: pitch=20, intensity=20, timbre=0
```

当前可选字幕 preset：

```text
songti_white_gold_lower
live_bar_lower
```

创建任务时，系统会把当时的设置保存为 `task.production_config` 快照。后续即使再改设置，也不会污染已经创建的任务。

### 3.2 创建批量任务

进入「产品」页。

左侧选择产品。当前默认可生产产品包括：

- 花西子气垫
- 防晒气垫

右侧会显示：

- 素材文件夹
- 最近入库 run
- 全量卖点
- 合规禁忌
- CTA 规则

填写创建批量任务参数：

- 平台
- 目标时长
- 生成数量
- 主卖点
- 活动优惠
- 禁忌
- 风格
- 受众
- CTA

点击「创建并运行」后，系统会按数量创建任务，并自动跑完整条生产 recipe。

### 3.3 查看任务过程

进入「任务」页。

左侧是任务列表。右侧会显示当前任务：

- 当前阶段
- 打开任务目录
- 失败原因和重试按钮
- 步骤列表
- 产物来源链
- QA Gate

每个任务会按固定阶段执行：

```text
task_brief
copy_brief
voice_script
tts_audio
audio_sections
timeline_selection
timeline_fill
caption_plan
subtitle_burn
qa_gate
export_record
```

如果某一步失败，任务会进入 `failed`，页面会显示失败步骤、原因、影响和重试入口。

### 3.4 查看成品

进入「成品」页。

只有通过 QA gate 或进入 QA 提醒状态的任务会显示在这里。点击「打开成片」可以定位到最终视频。

最终视频通常位于：

```text
cache/voah_tasks/{product_slug}/{timestamp}_{task_slug}/hyperframes_subtitle_burn/final_subtitled.mp4
```

## 4. 页面功能介绍

### 工作台

工作台是默认首页，不是功能按钮宫格。它显示当前生产状态：

- 正在处理
- 失败待处理
- 待确认
- 可生产产品
- 可生产产品入口
- 待处理队列
- 最近任务

设计目标是让新人打开后先知道“现在该处理什么”，而不是先思考点哪个功能。

### 产品

产品页用于选择要生产的产品，并创建批量任务。

当前产品页承担两件事：

- 读取可生产产品和对应素材入库 run。
- 填写本次生产 brief，并一键创建任务。

产品页不会让员工手动执行 Omni、向量化、切分等细步骤。素材入库是后台固定流程，执行完会登记 `latest_intake_run`、入库 QA 和产物路径。

### 任务

任务页是排查和返工入口。

核心能力：

- 看每个任务跑到哪一步。
- 看每一步产物是否成功。
- 看产物来源链。
- 打开任务目录。
- 失败后重试失败步骤。

任务页不是让员工理解代码细节，而是让员工知道“哪里失败、点哪里重跑、产物在哪里”。

### 成品

成品页展示通过 QA gate 的最终视频。

当前主要能力：

- 展示任务标题和 QA 摘要。
- 打开最终视频所在目录。
- 过滤掉 block 状态任务。

### 设置

设置页分两块：

- 模型 Key。
- 生产默认参数。

模型 Key 只让用户填 key。模型名、provider、base URL、endpoint 等固定在代码里的模型注册表，不让操作员乱填。

生产默认参数会在创建任务时固化为快照，用来保证产物来源可追溯。

## 5. 产物说明

单次任务目录：

```text
cache/voah_tasks/{product_slug}/{timestamp}_{task_slug}/
```

关键产物：

```text
task_brief.json                         任务输入、产品库字段、文案参数、配置快照
copy_brief.json                         销售逻辑和脚本意图
voice_script.json                       连续口播稿，TTS 和字幕文本真源
voice.wav                               最终口播音频
tts_audio.json                          TTS 记录、音频时长、TTS 参数
audio_sections.json                     口播语义段和时间轴
timeline_selection.json                 选片计划
timeline_fill.json                      视频填充结果
preview_no_subtitles.mp4                无字幕预览视频
caption_plan.json                       字幕文本、时间、样式和字体记录
hyperframes_subtitle_burn/index.html    HyperFrames 字幕工程
hyperframes_subtitle_burn/final_subtitled.mp4
qa_gate_report.json                     QA gate 结果
export_record.json                      成品导出记录
full_pipeline_manifest.json             全链路汇总
```

最重要的真源规则：

- 字幕文本来自 `voice_script.json` 的口播原文。
- TTS 音频是时间主轴。
- 素材填充读取 `audio_sections.json`。
- 字幕烧录读取 `caption_plan.json`。
- 设置参数以 `task.production_config` 和各阶段产物里的 `desktop_config` 为准。

## 6. 失败处理

常见失败类型：

- 模型 key 未配置。
- 素材索引不存在。
- TTS 接口失败或音频下载失败。
- 素材召回不够或选片失败。
- HyperFrames 字幕烧录失败；当前会先走 HyperFrames，超时或失败后自动用 PNG overlay 兜底烧录字幕。
- QA gate 阻断导出。

处理方式：

1. 先进入「任务」页。
2. 选择失败任务。
3. 看失败步骤和原因。
4. 若是 key 问题，去「设置」页补 key。
5. 若是阶段失败，点击重试失败步骤。
6. 必要时打开任务目录查看日志。

日志目录通常是：

```text
cache/voah_tasks/{product_slug}/{timestamp}_{task_slug}/logs/
```

## 7. 当前限制与下一步

当前限制：

- 素材入库已有产品页入口和 job 记录，但还没有独立素材库大页、失败 job 单独重试按钮和切分 QA 图墙。
- 批量任务能创建、连续运行并汇总状态，但还没有暂停/继续队列和真正的并发上限调度器。
- 成品页已有质检摘要、打开产物和通过/复查/退回记录，但还没有内嵌视频播放器。
- HyperFrames render 在本机可能卡在编译阶段，桌面端已加超时和 PNG overlay 兜底；后续可继续优化 HyperFrames 项目拆分。
- 视频去字幕模块还未实现。

建议下一步：

1. 做独立「素材库 / 入库任务」页面，把切分 QA 图墙、失败重试、最近 run 对比做完整。
2. 做任务队列并发控制，一次创建几十条后能控制运行数量、失败重试和暂停。
3. 成品页增加内嵌播放器、抽帧预览和批量导出。
4. 继续收紧文案与素材能力约束，让 `required_visual` 只写当前素材库能证明的画面。
5. 再考虑视频去字幕模块，先占位，不要影响当前主线生产。
