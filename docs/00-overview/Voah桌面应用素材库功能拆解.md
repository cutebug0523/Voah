# Voah 桌面应用素材库功能拆解

## 1. 模块定位

素材库是 Voah 的常驻资产层，不属于单次混剪任务。

员工视角：

```text
选择产品 -> 查看素材是否已入库 -> 发起/重跑入库 -> 检查可用素材量与风险 -> 进入批量生产
```

工程视角：

```text
Product
  -> ProductClaim
  -> IntakeRun
    -> Asset
    -> StoryUnit
    -> PhysicalShot
    -> EmbeddingChannel
    -> QaReport
```

素材库第一版不要做成剪辑器，也不要让员工直接管理每个 embedding。它的核心是回答：

- 这个产品有没有可用素材。
- 当前最新入库 run 是否可信。
- 可用于混剪的 story unit / physical shot 有多少。
- 哪些素材因为硬字幕、无音频、边界 QA、向量化失败需要处理。
- 能不能直接进入批量生产。

## 2. 对应现有 voah-video-intake 能力

| 桌面素材库能力 | 对应 skill / 产物 | 第一版界面呈现 |
|---|---|---|
| 产品从文件夹推导 | Step 0/1，路径推导产品身份 | 产品卡、source folder、slug |
| 原片扫描 | `assets.json` | 原片数量、时长、分辨率、音频轨 |
| 物理元数据 | ffprobe / `assets[].metadata_json` | 分辨率、fps、有无音频、编码 |
| 视觉候选切点 | `scene_segments_raw.json`、`scene_segments_merged_*.json` | 入库 run 详情中的候选段数量 |
| Omni 相邻分组 | `story_units.json` | story unit 列表、语义摘要、角色 |
| 物理干净镜头 | `physical_shots.json`、`trimmed_physical/` | physical shot 数量、可用区间、QA |
| 多通道向量化 | `vectorization_inputs.json`、`embedding_results.json` | 通道数、模型、维度、失败数 |
| 边界 QA | `contact_sheet.jpg`、`qa_last_frames/`、`qa_last_frames.json` | QA 状态、警告、末帧检查入口 |
| 入库总清单 | `run_manifest.json` | run 状态、产物路径、下一步消费者 |

## 3. 第一版页面信息架构

```text
素材库
  顶部：产品/素材健康概览 + 新建入库按钮
  左栏：产品列表
  中栏：选中产品详情、卖点/禁写/活动摘要、最新 intake run
  右栏：素材理解健康、QA、可进入生产状态
  底部：story unit / physical shot 表格
```

员工默认不需要看完整 JSON。JSON 入口保留为“打开产物目录 / 查看 manifest”。

## 4. Issues

### Issue 1：素材库静态页面第一版

目标：

- 在当前 Electron/React 原型中新增素材库子页面。
- 与首页使用同一套 sidebar、topbar、panel、table、button 视觉语言。
- 导航点击 `素材库` 时切换页面，不进入路由系统复杂化。

验收：

- 首页仍可访问。
- 素材库页显示产品列表、产品详情、入库 run、素材统计、QA 状态、story unit 表。
- `npm run build` 通过。

### Issue 2：Workspace 扫描已有 intake run

目标：

- 从 `cache/voah_video_intake/{product_slug}/{timestamp}_{run_label}/` 扫描已有 run。
- 读取 `run_manifest.json`、`assets.json`、`story_units.json`、`physical_shots.json`、`embedding_results.json`。
- 转成 Renderer 只需要的摘要结构。

验收：

- 能识别防晒气垫已有 run。
- run 摘要包含 asset_count、story_unit_count、physical_shot_count、embedding_channel_count、qa_status。
- 不把 API key 或 OSS 临时 URL 暴露到 UI。

### Issue 3：产品与卖点资料管理

目标：

- 产品主信息：name、brand、slug、source_folder。
- 产品 claim：selling_point、offer、cta、forbidden。
- 卖点 TOP、活动优惠、文案版本作为文案生成输入上下文，不作为运营 KPI。

验收：

- 产品资料可编辑并落盘。
- 单次任务可从产品资料读取文案上下文。

### Issue 4：发起素材入库 job

目标：

- Renderer 只提交 product_id、source_folder、run_label、参数。
- Main 调用 IntakeService 和 WorkerRunner。
- WorkerRunner 执行 voah-video-intake 对应 Python worker。

验收：

- 不能在 Renderer 直接拼 shell 命令。
- Step 0 目标目录来自用户选择，不自动扫全盘。
- job 状态进入 WorkerJob 状态机。

候选前端/服务边界 contract：

- `desktop/voah-app/src/lib/jobContracts.js`
- `createIntakeJobRequest(payload)`：Renderer 可提交的最小请求，只允许 `product_id`、`source_folder`、`source_folder_origin=user_selected`、`run_label` 和白名单 options。
- `createIntakeJobRecord(request, context)`：Main / IntakeService 创建 `WorkerJob` 草案，记录 `IntakeService`、`WorkerRunner`、`ArtifactService` 边界，不拼真实 shell。
- `createIntakeWorkerInput(request, context)`：生成 worker input manifest 候选，包含 workspace、scope、inputs、options、expected outputs 和 `secret_refs`，只记录 secret 引用，不包含 API key 值。
- `createIntakeArtifactRegistrationPlan(input)`：把 `run_manifest.json`、`assets.json`、`story_units.json`、`physical_shots.json`、`embedding_results.json` 等产物转换成 ArtifactService 登记计划。
- 对 Renderer 暴露的 job 状态固定为 `pending` / `running` / `succeeded` / `failed` / `canceled`；文档里的 `created` / `queued` / `warning` / `cancelled` 等 Main 层状态由 `mapWorkerStatusToRendererStatus` 收敛。

### Issue 5：入库 QA 视图

目标：

- 展示 QA checklist。
- 支持查看 contact sheet、末帧检查、低视觉差异边界、向量化失败。

验收：

- 能区分 warning 和 blocking failure。
- 失败 run 不能被标记为“可生产”。

### Issue 6：素材预览与筛选

目标：

- StoryUnit 表按 timeline_roles、voiceover_fit、hard_subtitle_risk、can_standalone、duration 筛选。
- PhysicalShot 作为 story unit 的可展开子项，不作为默认主视角。

验收：

- 默认展示 story unit。
- 需要短素材时可查看 child physical shots。

### Issue 7：进入批量生产

目标：

- 素材库为首页/任务模块提供“可生产产品”状态。
- 点击进入生产时带上 product_id、latest_intake_run_id、product_claims。

验收：

- 无可用 intake run 时不能进入生产。
- 有 warning 时给出确认提示。

候选前端/服务边界 contract：

- `desktop/voah-app/src/data/productionReadiness.js`
- `deriveProductionReadiness(input)`：从 product、product_claims、intake_runs 推导 `ready` / `needs_confirmation` / `blocked`。
- `buildBatchProductionPayload(readiness, options)`：进入批量生产时输出 `product_id`、`latest_intake_run_id`、`product_claims` 和 warning 确认记录。
- `buildHomepageProductionState(input)`：首页批量生产入口可复用素材库 readiness，不需要另写判断。
- 阻断条件包括：无产品、无 intake run、run 未 ready、run failed、blocking QA failure、素材/故事单元/物理镜头/embedding 数量不足、必需 artifact 缺失。
- warning 条件包括：run warning、QA warning、QA 状态未知、产品卖点为空、计数字段缺失、可选 artifact 缺失；warning 必须确认后才能生成批量生产 payload。
