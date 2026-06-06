# Voah 桌面应用模块与产物流转设计

## 1. 文档目的

这份文档只做架构设计，不做界面设计，不落代码。

目标是回答：

- 桌面应用应该分多少功能模块。
- 每个模块承担什么职责。
- 模块之间靠什么产物流转。
- 哪些流程必须串行，哪些可以并发。
- Electron / Node / Python / ffmpeg / HyperFrames 的边界怎么划。
- 后续真正开工时，哪些设计可以直接变成代码结构。

当前前提：

```text
Electron + Node.js 做桌面主应用和本地调度
Python 继续承载已有 Voah worker 能力
ffmpeg / ffprobe 作为本地媒体工具
HyperFrames 负责字幕与 HTML 视频渲染
SQLite 记录结构化状态
文件系统保存大产物和每一步 JSON
```

桌面端不是 agent 外壳，不直接调用 skills。历史 skills 的价值是沉淀流程规格、schema 和 QA 清单。

## 2. 设计原则

### 2.1 员工看到流程，系统保存产物

员工不应该知道：

```text
cache/voah_tasks/...
voice_script.json
timeline_fill.json
HyperFrames CLI 参数
```

系统必须知道，并且每一步都要落盘。

### 2.2 产物是真源，不是界面状态

界面状态可以丢，产物不能丢。

任何关键阶段都必须有：

```json
{
  "schema_version": "1.0.0",
  "stage": "stage_name",
  "inputs": {},
  "outputs": {},
  "qa": {},
  "next_consumers": []
}
```

### 2.3 入库是常驻层，混剪是任务层

素材入库不属于每次混剪任务正文。

```text
常驻素材库
  -> 单次混剪任务
```

单次任务从任务 brief、产品卖点、平台目标和销售逻辑开始。

### 2.4 音频主轴驱动视频与字幕

当前主线：

```text
先定全片销售逻辑
  -> 连续口播
  -> TTS
  -> audio_sections
  -> 按口播语义贴素材
  -> 口播原文断句字幕
```

不要回到 `先选 shot -> 每个 shot 写一句 -> 再凑音频` 的旧路径。

## 3. 模块划分推演

### 3.1 第一轮：按现有管线切

最直接的切法：

```text
素材入库
文案
TTS
召回
剪辑
字幕
渲染
QA
设置
```

优点：

- 和现有 Voah skill/脚本对应，容易迁移。
- 每一步产物边界清楚。

问题：

- 员工视角太工程化。
- “召回”和“剪辑”对非技术人员不友好。
- 任务运行、失败重试、历史版本没有独立位置。
- 产品卖点库和素材库关系不够清楚。

结论：

这轮适合作为内部 worker 分层，不适合作为最终应用模块。

### 3.2 第二轮：按员工操作切

更像桌面软件的切法：

```text
首页
素材库
产品库
文案工厂
语音工厂
混剪工厂
字幕渲染
成品库
设置
```

优点：

- 员工能理解。
- “工厂”代表一个产物生产阶段。
- 成品有地方回看、导出、复盘。

问题：

- 产品库和素材库可能割裂。
- 任务运行和产物追踪还不够中心化。
- 入库 run、任务 run、TTS run、渲染 run 都散落在各模块。

结论：

这轮适合作为导航语言，但系统内部还需要一个统一任务中心和产物中心。

### 3.3 第三轮：按产物生命周期切

从产物真源反推模块：

```text
工作区与设置
产品与素材资产
入库运行
任务运行
文案版本
音频版本
时间线版本
字幕版本
渲染版本
QA 与发布记录
```

优点：

- 每个模块都对应可落库对象。
- 适合 SQLite 和文件系统双写。
- 断点恢复、版本回滚、失败重试天然清楚。

问题：

- 员工看到会觉得过于后台。
- “版本”和“运行”如果直接暴露，操作成本高。

结论：

这轮适合作为数据模型和本地服务边界，不适合作为员工主导航。

### 3.4 第四轮：收敛方案

最终 V1 采用“双层模块”：

```text
员工可见模块：8 个
系统内部模块：12 个
```

员工可见模块用于操作路径。

系统内部模块用于代码、数据、任务调度和产物管理。

## 4. V1 员工可见模块

### 4.1 首页 / 工作台

定位：

```text
看当前有哪些产品、哪些任务在跑、下一步该做什么。
```

职责：

- 展示最近产品。
- 展示正在运行的任务。
- 展示待人工确认项。
- 展示失败任务和可重试入口。
- 展示最近导出的成片。

不承担：

- 不做四个大按钮式功能宫格。
- 不做营销首页、欢迎页或视觉炫技页。
- 不编辑具体文案。
- 不直接管理素材细节。
- 不做复杂渲染设置。

核心读取：

```text
products
intake_runs
task_runs
render_outputs
qa_reports
```

首页应该按“工作状态”组织，而不是按“功能按钮”组织。员工打开后首先看到：

```text
今天正在跑什么
哪里失败了需要重试
哪里需要人工确认
哪些产品已经可以批量生产
最近导出了哪些成片
```

推荐信息结构：

```text
首页 / 工作台
  顶部状态条
    - 正在处理
    - 失败待处理
    - 待确认
    - 今日完成
  主任务流
    - 正在运行的素材处理 / 混剪 / 字幕渲染任务
    - 每条任务只显示产品、阶段、进度、下一步动作
  待处理队列
    - 失败重试
    - QA 确认
    - 文案确认
    - 声音确认
  可生产产品
    - 产品名
    - 素材状态
    - 卖点状态
    - 进入批量生产
  最近成片
    - 预览
    - 导出路径
    - QA 状态
```

功能入口应该嵌在具体对象和任务里：

```text
产品没素材 -> 产品卡上显示“处理素材”
任务失败 -> 任务卡上显示“重试失败步骤”
素材可生产 -> 产品卡上显示“进入批量生产”
成片完成 -> 成片卡上显示“打开 / 导出”
```

不要把首页设计成：

```text
素材处理
批量混剪
视频去字幕
任务历史
```

这种粗粒度按钮宫格会让员工每次先思考“我要点哪个功能”，而不是直接看到“现在该处理哪个对象”。

### 4.2 产品与素材库

定位：

```text
一个产品对应一批素材、一套卖点、一组可复用素材理解结果。
```

职责：

- 创建产品。
- 绑定产品文件夹。
- 管理产品名、品牌、slug。
- 管理产品全量卖点、禁忌、CTA、活动信息。
- 查看该产品有哪些素材入库 run。
- 导入 / 导出素材索引。

核心产物：

```text
product_profile.json
product_claims.json
intake_run references
```

### 4.3 素材入库

定位：

```text
把原片变成可检索、可复用、可追溯的素材资产。
```

职责：

- 选择素材文件夹或新增素材。
- 执行 ffprobe。
- 执行视觉切点候选。
- 调用 Omni / VLM 理解。
- 生成 story units / physical shots。
- 上传临时 OSS 或可访问 URL。
- 调用 qwen3-vl-embedding。
- 做切分边界 QA。
- 产出可复用 intake run。

核心产物：

```text
run_manifest.json
assets.json
story_units.json
physical_shots.json
embedding_results.json
shot_index.json
trimmed_physical/
qa_last_frames.json
```

下游：

```text
混剪任务 / 素材召回
文案工厂的素材参考
```

### 4.4 文案工厂

定位：

```text
先定销售逻辑，再生成连续口播。
```

职责：

- 读取产品卖点库。
- 读取任务 brief、平台、目标时长、活动优惠。
- 生成或编辑销售逻辑。
- 生成 `copy_brief.json`。
- 生成或编辑连续口播 `voice_script.json`。
- 管理文案版本。

核心产物：

```text
task_brief.json
copy_brief.json
voice_script.json
copy_versions
```

下游：

```text
语音工厂
字幕文本真源
素材召回语义依据
```

禁止：

```text
不以 shot 为单位写碎片化文案。
不让 subtitle_text 独立改写口播。
```

### 4.5 语音工厂

定位：

```text
从连续口播生成最终音频主轴。
```

职责：

- 选择 TTS provider 和 voice_id。
- 管理 MiniMax 参数。
- 一次性 TTS 生成 `voice.wav`。
- 记录原始响应和安全响应。
- 根据口播结构和时间线生成 `audio_sections.json`。
- 试听不同音色。
- 管理音频版本。

核心产物：

```text
voice_minimax_oneshot.mp3
voice.wav
tts_audio.json
audio_sections.json
pronounce_text.txt
```

下游：

```text
混剪工厂
字幕渲染
QA
```

### 4.6 混剪工厂

定位：

```text
按音频语义和时长召回素材，并生成无字幕时间线。
```

职责：

- 读取 `audio_sections.json`。
- 读取素材库 `shot_index.json`。
- 按每段 voice_text / intention_copy / required_visual 召回素材。
- 做产品过滤、语义 rerank、视觉 rerank、时长适配。
- 允许人工锁定、替换或禁用素材。
- 输出无字幕预览。

核心产物：

```text
candidate_sections.json
selection_overrides.json
timeline_fill.json
preview_no_subtitles.mp4
timeline_fill_clips/
```

下游：

```text
字幕渲染
QA
```

### 4.7 字幕与渲染

定位：

```text
用口播原文断句生成字幕，并用 HyperFrames / ffmpeg 输出成片。
```

职责：

- 从 `audio_sections.json` 生成 `caption_plan.json`。
- 管理字幕 preset。
- 创建 HyperFrames 工程。
- 调用 HyperFrames 渲染字幕。
- 调用 ffmpeg 做必要转码、拼接和封装。

核心产物：

```text
caption_plan.json
subtitle_presets.json
hyperframes_subtitle_burn/
hyperframes_subtitle_burn_manifest.json
final_subtitled.mp4
```

下游：

```text
QA 与导出
```

禁止：

```text
不把 MiniMax subtitle_file 的粗分段当正式字幕。
不把 ASR 文本当字幕文本真源。
```

### 4.8 QA 与成品库

定位：

```text
检查、复盘、导出和沉淀经验。
```

职责：

- ffprobe 检查。
- freezedetect。
- 抽帧检查。
- 字幕覆盖和可读性检查。
- 记录 warning。
- 输出完整 manifest。
- 管理成品导出路径。
- 复盘本轮 rerank / 素材 / 文案 / TTS 问题。

核心产物：

```text
full_pipeline_manifest.json
qa_report.json
qa_frames/
export_record.json
```

下游：

```text
产品复用
rerank 规则优化
下一轮任务
```

## 5. 系统内部模块

员工可见 8 个模块背后，内部建议拆 12 个模块。

### 5.1 WorkspaceService

职责：

- 管理 workspace root。
- 管理 cache root。
- 管理用户配置路径。
- 校验 ffmpeg、ffprobe、Python、HyperFrames 是否可用。

不保存 API key 明文到仓库。

### 5.2 ConfigService

职责：

- 管理 provider 配置。
- 管理模型名、base_url、默认参数。
- 从本地安全配置或系统 keychain 读取 key。
- 向 worker 注入环境变量。

### 5.3 ArtifactService

职责：

- 所有产物路径注册。
- 读写 manifest。
- 校验 schema_version。
- 维护产物依赖图。
- 支持导入 / 导出。

这是桌面端的核心服务之一。

### 5.4 DatabaseService

职责：

- SQLite 初始化和 migration。
- 记录产品、run、artifact、worker job、QA 状态。
- 只存结构化索引，不存大媒体。

### 5.5 JobQueueService

职责：

- 管理任务队列。
- 控制并发数。
- 记录任务状态机。
- 支持暂停、取消、重试。
- 保存 stdout/stderr 日志。

### 5.6 WorkerRunner

职责：

- 调用 Python 脚本。
- 调用 ffmpeg / ffprobe。
- 调用 HyperFrames CLI。
- 统一收集返回码、日志、产物和 QA。

### 5.7 ProductService

职责：

- 产品 CRUD。
- 产品 slug。
- 产品卖点库。
- 产品目录绑定。
- intake run 和 task run 的产品归属。

### 5.8 IntakeService

职责：

- 把产品素材变成 intake run。
- 管理入库任务的子步骤和并发。
- 维护 story unit / physical shot / embedding 索引。

### 5.9 CopyService

职责：

- 生成 / 保存 task_brief。
- 生成 / 保存 copy_brief。
- 生成 / 保存 voice_script。
- 管理文案版本。

### 5.10 VoiceService

职责：

- TTS 参数管理。
- 运行 TTS。
- 生成 audio_sections。
- 管理音频版本和试听样本。

### 5.11 AssemblyService

职责：

- 召回候选。
- rerank。
- selection_overrides。
- timeline_fill。
- 无字幕预览。

### 5.12 RenderQaService

职责：

- caption_plan。
- HyperFrames 工程。
- final_subtitled。
- ffprobe / freezedetect / frames。
- full_pipeline_manifest。

## 6. 产物流转总图

```text
ProductService
  -> product_profile.json
  -> product_claims.json

IntakeService
  input: product folder / raw videos
  output:
    run_manifest.json
    assets.json
    story_units.json
    physical_shots.json
    embedding_results.json
    shot_index.json

CopyService
  input:
    task_brief
    product_claims
    optional source_meaning summaries
  output:
    task_brief.json
    copy_brief.json
    voice_script.json

VoiceService
  input:
    voice_script.json
    tts provider config
  output:
    voice.wav
    tts_audio.json
    audio_sections.json

AssemblyService
  input:
    audio_sections.json
    shot_index.json
  output:
    candidate_sections.json
    selection_overrides.json
    timeline_fill.json
    preview_no_subtitles.mp4

RenderQaService
  input:
    audio_sections.json
    timeline_fill.json
    preview_no_subtitles.mp4
  output:
    caption_plan.json
    hyperframes_subtitle_burn/
    final_subtitled.mp4
    qa_report.json
    full_pipeline_manifest.json
```

## 7. 任务状态机

所有 job 统一状态：

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

状态解释：

- `created`：任务已创建但未排队。
- `queued`：等待执行。
- `running`：正在执行。
- `awaiting_review`：需要人工确认，例如切分边界、文案、素材候选。
- `succeeded`：产物完整且 QA 通过。
- `warning`：产物可用但有 warning。
- `failed`：失败且没有可用下游产物。
- `cancelled`：用户取消。
- `stale`：上游产物变化后，下游产物过期。

重要规则：

- 失败不能只显示错误，必须指向日志和上一步产物。
- 下游产物不能静默复用 stale 上游。
- warning 可以进入下一步，但必须在最终 manifest 中保留。

## 8. 依赖与并发

### 8.1 可并发

素材入库内：

```text
ffprobe 多视频
scene candidate 多视频
抽帧 / contact sheet
Omni 分视频理解
embedding 分片段/分通道
```

任务层：

```text
多个 TTS 试听
多个素材候选预览
多个 QA 抽帧
```

### 8.2 必须串行

```text
product_profile -> intake_run
copy_brief -> voice_script
voice_script -> voice.wav
voice.wav -> audio_sections
audio_sections -> timeline_fill
timeline_fill -> caption_plan
caption_plan -> final_subtitled
final_subtitled -> qa_report
```

### 8.3 可人工插入

```text
story unit 边界确认
copy_brief 调整
voice_script 调整
TTS 音色确认
selection_overrides
字幕 preset 确认
最终 QA 确认
```

人工修改会让相关下游标记为 `stale`。

## 9. SQLite 与文件系统分工

### 9.1 SQLite 存什么

```text
products
product_claims
intake_runs
assets
story_units
physical_shots
embedding_channels
task_runs
artifacts
worker_jobs
copy_versions
tts_runs
audio_sections
timeline_items
caption_runs
render_outputs
qa_reports
settings
```

SQLite 里存路径、状态、摘要、时间、关联关系，不存大媒体和完整 embedding。

### 9.2 文件系统存什么

继续沿用：

```text
cache/voah_video_intake/{product_slug}/{timestamp}_{run_label}/
cache/voah_tasks/{product_slug}/{timestamp}_{task_slug}/
```

大文件、原始响应、embedding、视频、音频、截图都在文件系统。

### 9.3 Artifact Registry

每一个产物在 SQLite 中记录：

```text
artifact_id
run_id
stage
kind
path
schema_version
created_at
producer_job_id
consumers
qa_status
content_hash
```

`content_hash` 用于判断下游是否 stale。

## 10. Electron / Node / Python / HyperFrames 边界

### 10.1 Electron Renderer

职责：

- 展示状态。
- 发起操作。
- 播放预览。
- 展示日志和 QA。
- 不直接访问文件系统。
- 不直接调用 Python/ffmpeg。

### 10.2 Electron Main / Node

职责：

- IPC 边界。
- 文件选择。
- job queue。
- SQLite。
- worker 调度。
- 安全配置读取。
- 产物注册。

Node 是本地总调度，不负责模型推理本身。

### 10.3 Python Workers

职责：

- 复用现有 Voah 脚本能力。
- 调模型 API。
- 处理 JSON。
- 做音频 / 视频辅助分析。

Python worker 必须遵守统一输出合同。

### 10.4 ffmpeg / ffprobe

职责：

- 元数据。
- 切割。
- 拼接。
- 转码。
- 抽帧。
- freezedetect。

ffmpeg 命令由 Node 调度，参数由 worker 或 service 生成。

### 10.5 HyperFrames

职责：

- 字幕视觉层。
- HTML composition。
- 字幕烧录。
- 未来可做更复杂的图文/动效包装。

HyperFrames 工程是任务产物的一部分，不是临时目录。

## 11. Worker 合同

所有 worker 统一输入：

```json
{
  "job_id": "uuid",
  "stage": "voah_tts",
  "workspace_root": "/absolute/path",
  "task_dir": "/absolute/path",
  "inputs": {},
  "options": {},
  "env_keys": ["MINIMAX_API_KEY"]
}
```

所有 worker 统一输出：

```json
{
  "schema_version": "1.0.0",
  "job_id": "uuid",
  "stage": "voah_tts",
  "status": "succeeded",
  "inputs": {},
  "outputs": {},
  "qa": {
    "status": "ok",
    "warnings": []
  },
  "logs": {
    "stdout_path": "/absolute/path",
    "stderr_path": "/absolute/path"
  },
  "next_consumers": []
}
```

关键约束：

- worker 不直接弹 UI。
- worker 不把 key 写入输出。
- worker 不只返回终端文本。
- worker 失败也要写失败 manifest。

## 12. IPC 边界草案

这里只定义能力，不设计 UI。

```text
workspace:getStatus
workspace:setRoot
settings:get
settings:set

products:list
products:create
products:update
products:getDetail

intake:createRun
intake:startRun
intake:getRun
intake:listRuns

tasks:create
tasks:get
tasks:list
tasks:markStale

copy:createBrief
copy:createVoiceScript
copy:listVersions

voice:createTtsRun
voice:getAudioSections

assembly:createTimeline
assembly:updateSelectionOverrides

render:createCaptionPlan
render:startHyperFramesBurn

qa:runChecks
qa:getReport

jobs:list
jobs:get
jobs:cancel
jobs:retry

artifacts:get
artifacts:revealInFinder
artifacts:exportBundle
```

## 13. V1 实现顺序建议

### 13.1 第一阶段：架构壳

- Electron + Node 工程。
- SQLite migration。
- ArtifactService。
- JobQueueService。
- WorkerRunner。
- 极简状态页，不做视觉设计。

### 13.2 第二阶段：接入已有产物

- 扫描现有 `cache/voah_video_intake`。
- 扫描现有 `cache/voah_tasks`。
- 把已有防晒气垫主线回归导入 SQLite。
- 只读展示产物链。

### 13.3 第三阶段：任务层跑通

- 从 `voice_script.json` 开始跑 TTS。
- 跑 `audio_sections`。
- 跑素材召回。
- 跑 caption_plan。
- 跑 HyperFrames。
- 跑 QA。

### 13.4 第四阶段：素材入库跑通

- 产品文件夹导入。
- ffprobe。
- 切分候选。
- Omni。
- embedding。
- 边界 QA。

### 13.5 第五阶段：员工操作优化

- 人工确认点。
- 失败重试。
- 版本回滚。
- 导入导出素材库。
- 成品库。

## 14. 当前结论

V1 不应该按“技能菜单”设计，而应该按“产物生命周期”设计。

最终模块口径：

```text
员工可见：8 个模块
系统内部：12 个服务模块
核心真源：ArtifactService + SQLite + 文件系统 manifest
主线节奏：连续口播 -> TTS/audio_sections -> 素材填充 -> 字幕渲染 -> QA
```

真正开工前，优先确认：

1. SQLite schema 是否按这 12 个内部模块设计。
2. 现有脚本是否先包一层统一 worker manifest。
3. `ArtifactService` 是否先做，因为它是所有模块的共同底座。
4. 首页只做任务状态和下一步，不抢业务模块职责。
