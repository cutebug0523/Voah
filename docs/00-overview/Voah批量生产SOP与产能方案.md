# Voah 批量生产 SOP 与产能方案

## 1. 问题定义

现有 Voah skills 已经验证：

```text
素材入库
  -> 销售逻辑
  -> 连续口播
  -> TTS 音频主轴
  -> 按口播语义贴素材
  -> 字幕烧录
  -> QA
```

可以产出达到投放标准的视频。

当前瓶颈不是“效果不行”，而是“生产方式不对”：

```text
Codex / agent 能跑
  -> 但单条约 30 分钟
  -> 大量时间花在临场调度、判断、返工和复核
  -> 无法支撑一天 150 条
```

结论：

```text
不要继续优化 agent 手工跑一条视频。
要把成熟 SOP 固化成生产系统：
任务队列 + worker + artifact registry + QA gate + 异常审核。
```

## 2. 核心判断

### 2.1 单条视频不是主要并发单位

单条视频内部关键路径强依赖音频主轴：

```text
copy_brief
  -> voice_script
  -> voice.wav
  -> audio_sections
  -> timeline_fill
  -> caption_plan
  -> final_subtitled
  -> qa_gate_report
```

TTS 和 `audio_sections` 没出来之前，后面的素材填充、字幕、最终渲染都不能稳定开始。

真正可扩产的单位是：

```text
产品素材常驻入库
多个 TaskRun 并发
多个 worker lane 并发
异常队列集中处理
```

### 2.2 150 条/天不是“一个 agent 更快”

粗略产能账：

```text
当前：约 30 分钟 / 条
单 lane 24 小时理论上限：48 条 / 天
单 lane 8 小时人工班次：16 条 / 天
150 条 / 天要求：全天平均 9.6 分钟出 1 条
```

合理目标模型：

```text
4 条并发生产 lane
每条 lane 约 2 条 / 小时
24 小时理论上限：192 条 / 天
按 75%-80% 利用率扣除失败、重试、API 抖动、QA warning
实际约 144-154 条 / 天
```

前提：

- 素材入库提前完成，不计入单条任务生产时间。
- 文案、TTS、召回、字幕、渲染都 worker 化。
- TTS / 模型 API 至少支持 4 并发，最好 8 并发留重试余量。
- 人工只处理异常、确认和抽检，不逐条深度制作。

## 3. 生产系统分层

### 3.1 常驻素材层

定位：

```text
把产品素材变成可复用资产。
```

后台固定流程：

```text
scan_sources
  -> probe_assets
  -> detect_scene_candidates
  -> omni_group_story_units
  -> trim_physical_shots
  -> trim_boundary_qa
  -> upload_accessible_clips
  -> embed_multichannel
  -> build_index
  -> finalize_manifest
```

员工只看到：

```text
产品是否可生产
素材是否处理完成
失败卡在哪一步
能不能重试失败步骤
```

不让新人理解：

```text
Omni
scene candidate
physical shot
embedding channel
OSS URL
cache 深层路径
```

### 3.2 单次任务层

定位：

```text
围绕一个投放目标生成一条视频。
```

标准流水线：

```text
task_brief
  -> copy_brief
  -> voice_script
  -> tts_audio / voice.wav / audio_sections
  -> candidate_sections / timeline_fill / preview_no_subtitles
  -> caption_plan
  -> final_subtitled
  -> qa_gate_report
  -> export_record
```

每一步都必须落盘，并写：

```text
schema_version
inputs
outputs
qa
next_consumers
```

### 3.3 生产调度层

核心对象：

```text
TaskRun：业务任务聚合
JobRun：单个 worker 执行记录
Artifact：可复用、可追溯的产物真源
QaGateReport：决定能否进入成品库
```

状态建议：

```text
TaskRun:
draft / ready / running / awaiting_review / rendered / qa_warning / completed / failed / archived

JobRun:
created / queued / running / awaiting_review / succeeded / warning / failed / cancelled / stale

Artifact:
planned / producing / registered / valid / warning / stale / failed / archived
```

规则：

- 上游 artifact 改变，下游全部标记 `stale`。
- 失败重试必须新建 JobRun，并记录 `retry_of_job_id`。
- warning 可以继续下游，但必须进入最终 QA。
- 人工改口播，会作废 TTS、audio_sections、timeline、字幕、渲染、QA。
- 人工改素材选择，只作废 timeline、preview、render、QA。

## 4. 新人可操作 SOP

新人理想操作不超过 7 步：

```text
1. 打开工作台，看可生产产品和待处理任务。
2. 选择产品，确认素材状态是“可生产”。
3. 填任务 brief：平台、目标时长、主卖点、活动、禁忌。
4. 生成文案，确认销售逻辑和连续口播。
5. 生成 TTS，试听声音、语速和总时长。
6. 自动贴素材，看无字幕预览，只做替换 / 锁定 / 禁用片段。
7. 自动生成字幕和成片，按 QA 清单检查后导出。
```

新人必须确认：

- 产品身份、卖点、禁忌、活动信息。
- 文案销售逻辑：开头、卖点顺序、证明方式、CTA。
- 连续口播是否自然、是否超时、是否夸大。
- TTS 声音、语速、情绪、读法。
- 无字幕预览中画面是否支撑口播。
- 最终成片中字幕是否挡脸、挡产品、和原硬字幕冲突。

新人不该碰：

- JSON 文件、cache 路径、manifest、schema。
- skill 名、脚本参数、ffmpeg / HyperFrames 命令。
- API key、voice_id、embedding、OSS URL。
- 手工时间码、audio_sections、召回分数。
- 强制跳过失败步骤。

## 5. 批量生产模式

一天 150 条时，产品重点不是逐条制作，而是：

```text
批量创建
自动生产
异常集中处理
warning 必审
抽检放行
```

需要支持的批量能力：

- 按产品、平台、时长、卖点模板批量创建 TaskRun。
- 批量生成 `copy_brief` / `voice_script`。
- TTS 队列，支持 provider 限流、并发和失败重试。
- 批量素材召回和无字幕预览。
- 批量应用字幕 preset。
- 批量渲染、导出命名和 QA 报告。

工作台应该像生产看板：

```text
待生成
运行中
待确认
失败待处理
QA warning
可导出
已完成
```

不要让员工逐条打开 150 个任务翻素材。

## 6. 必须 worker 化的能力

优先级从高到低：

### P0：任务队列与产物登记

没有它就无法规模化。

必须有：

- JobQueueService
- WorkerRunner
- ArtifactService
- 状态机
- stage timing
- 日志路径
- 失败原因
- 从失败步骤重试
- stale 依赖传播

### P1：文案与 TTS 时长硬约束

当前低效之一是：

```text
文案写完 -> TTS 后才发现超时 -> 回头压缩 -> 重跑
```

应改为：

- copy-final 阶段根据目标时长、历史语速和 TTS 参数估算字数区间。
- 超出区间自动重写，不等 TTS 后才返工。
- TTS 后若超出目标，只能回到文案阶段，不默认硬加速或硬剪。

### P1：素材 rerank 规则化

人工 override 只能作为训练证据，不应该成为日常生产步骤。

强规则要覆盖：

- 产品匹配。
- `required_visual` 精确命中。
- `required_meaning` 与 `source_meaning` 对齐。
- role：opening / product / proof / cta。
- hard_subtitle_risk。
- voiceover_fit。
- 时长适配。
- 禁止默认 loop。

### P1：QA Gate

每条视频最终必须生成：

```text
qa_gate_report.json
```

它决定能否进入成品库，而不是靠自然语言复盘或人工印象。

## 7. 最小 QA Gate

放行状态：

```text
pass
manual_review
block
```

优先级：

```text
block > manual_review > pass
```

### Gate 1：Artifact Gate

必须存在：

```text
task_brief
copy_brief
voice_script
tts_audio
voice.wav
audio_sections
candidate_sections
timeline_fill
caption_plan
final_subtitled
```

每个关键产物必须有：

```text
schema_version
inputs
outputs
qa
next_consumers
```

缺失直接 `block`。

### Gate 2：Voice & Caption Gate

检查：

- `script_sections[].voice_text` 拼回 `full_voice_text`。
- 字幕文本拼回口播原文。
- 字幕策略是口播原文断句。
- TTS 时长在目标范围。

失败直接 `block`。

### Gate 3：Timeline Gate

检查：

- 每个 `audio_section` 都有素材填充。
- 最终视频时长与 `voice.wav` 差值不超过 0.3 秒。
- 不使用默认 loop 凑时长。
- `hard_subtitle_risk=high` 直接 `block`。
- `hard_subtitle_risk=medium` 进入 `manual_review`。

### Gate 4：Render Gate

检查：

- 竖屏规格正确，例如 720x1280。
- fps 正常，例如 30fps。
- 音频存在。
- `freezedetect` 无事件。
- HyperFrames lint 无 error。
- HyperFrames inspect 无 layout issue。

失败直接 `block`。

### Gate 5：Human Spot Gate

批量生产默认：

- 每条自动抽帧。
- 首 3 秒和末 5 秒生成短预览。
- warning 必审。
- 每批至少抽检 10%。

如果抽检发现：

```text
画面不证明口播
字幕冲突
明显廉价循环
产品或优惠错误
```

则暂停同批次，回查同类 section 规则。

## 8. 操作边界

V1 不做复杂角色体系，不区分管理员、工程角色和操作员权限。

桌面端只围绕一个默认使用者设计：

```text
只会点鼠标的新手操作员
```

系统内部可以有配置、日志、工程详情和排错能力，但它们不作为日常角色入口，不在主流程里出现。

### 新手操作员

职责：

- 填 brief。
- 确认文案。
- 试听 TTS。
- 看无字幕预览。
- 处理系统给出的替换 / 锁定 / 禁用片段。
- 做最终 QA 和导出。

不负责：

- 处理 API key。
- 排查模型调用。
- 改 JSON。
- 改时间码。
- 跑命令。

### 系统自动处理

职责：

- 调度 worker。
- 记录产物来源。
- 管理任务状态。
- 从失败步骤重试。
- 标记 stale 下游产物。
- 生成 QA gate。
- 阻断低质成片进入成品库。

### 少量人工配置

这部分不做成独立角色，只作为设置页或工程详情里的低频入口。

包括：

- 配置 provider 和 API key。
- 选择默认 TTS 声音。
- 选择字幕 preset。
- 选择 workspace root。
- 查看失败日志。
- 打开产物目录。

原则：

```text
日常生产不进入这些入口。
新人只处理系统给出的业务动作。
```

## 9. 实施路线

### Phase 1：把 agent 调度替换成本地生产队列

目标：

```text
单产品、单机器、可连续跑 10 条任务。
```

必须实现：

- TaskRun / JobRun / Artifact 基础表。
- WorkerRunner。
- 现有脚本统一 `--input job_input.json --output job_result.json`。
- 从失败步骤重试。
- stage timing。
- `qa_gate_report.json` 初版。

### Phase 2：批量任务池

目标：

```text
同产品批量生成 20-30 条。
```

必须实现：

- 批量创建 task brief。
- 文案模板和时长约束。
- TTS 队列。
- 召回/渲染并发。
- 异常队列。
- warning 必审。

### Phase 3：150 条/天压测

目标：

```text
4 条生产 lane，跑满一天，实际产出 150 条附近。
```

必须测：

- TTS/API 并发上限。
- 渲染耗时和机器瓶颈。
- 单条平均耗时。
- 失败率。
- warning 比例。
- 人工平均处理时间。
- 抽检坏片率。

## 10. 当前最重要结论

Voah 现在已经证明了“能做出好视频”。

下一步不是继续让 Codex 做更聪明的剪辑师，而是把 Codex 已经跑通的 SOP 拆成：

```text
机器稳定跑
人只确认风险
产物可追溯
错误可重试
质量有硬门
批量有队列
```

一句话：

```text
从 agent 手艺活，升级成队列工厂。
```
