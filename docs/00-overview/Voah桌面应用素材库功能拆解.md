# Voah 桌面应用素材库功能拆解

## 1. 模块定位

素材库是 Voah 的常驻资产层，不属于单次混剪任务。

员工视角：

```text
选择产品文件夹
  -> 一键素材处理
  -> 看处理状态
  -> 失败时重试失败步骤
  -> 完成后进入批量生产
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

素材库第一版不要做成剪辑器，也不要让员工直接管理每个 embedding、模型步骤或深层 JSON。

它的核心是回答：

- 这个产品有没有可用素材。
- 当前素材处理是否完成。
- 如果失败，卡在哪一步，能不能重试。
- 可用于混剪的素材量是否够。
- 能不能直接进入批量生产。

## 2. 对应现有 voah-video-intake 能力

这些能力是后台固定流程，不是员工需要逐项操作的功能入口。

| 后台步骤 | 对应 skill / 产物 | 员工界面呈现 |
|---|---|---|
| 产品从文件夹推导 | Step 0/1，路径推导产品身份 | 产品名、素材文件夹 |
| 原片扫描 | `assets.json` | 原片数量、总时长 |
| 物理元数据 | ffprobe / `assets[].metadata_json` | 只在详情里显示异常，例如无音频、分辨率异常 |
| 视觉候选切点 | `scene_segments_raw.json`、`scene_segments_merged_*.json` | 默认隐藏；失败或 QA 时展开 |
| Omni 相邻分组 | `story_units.json` | 素材可用段数量、粗略内容覆盖 |
| 物理干净镜头 | `physical_shots.json`、`trimmed_physical/` | 可用片段数量、失败片段数量 |
| 多通道向量化 | `vectorization_inputs.json`、`embedding_results.json` | 向量化完成 / 失败 / 可重试 |
| 边界 QA | `contact_sheet.jpg`、`qa_last_frames/`、`qa_last_frames.json` | QA 通过 / 需确认 / 阻断 |
| 入库总清单 | `run_manifest.json` | 素材处理完成状态 |

## 3. 第一版交互结构

```text
素材库
  产品列表
    - 产品名
    - 素材处理状态
    - 可生产状态
    - 最近更新时间
  产品详情
    - 产品资料与卖点上下文
    - 素材文件夹
    - 最新素材处理任务
    - 进入批量生产
  素材处理任务详情
    - 当前步骤
    - 总体状态
    - 失败原因
    - 重试失败步骤
    - 打开产物目录
  工程详情
    - 默认折叠
    - 只在排错、QA、人工复核时展开
```

员工默认不需要看完整 JSON，不需要理解 Omni、ffprobe、scene candidate、embedding channel。
JSON 入口保留为“打开产物目录 / 查看 manifest”，用于排错和工程复核。

## 4. Job 化原则

素材处理在桌面端必须是一条可恢复的 `intake job`，而不是一组让员工手动串起来的按钮。

前台只暴露：

```text
开始处理
查看状态
重试失败步骤
取消任务
打开产物目录
```

后台步骤固定：

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

每个步骤都要写入：

```json
{
  "step": "embed_multichannel",
  "status": "running",
  "started_at": "2026-06-06T01:00:00+0800",
  "finished_at": null,
  "inputs": {},
  "outputs": {},
  "qa": {
    "status": "pending",
    "warnings": []
  },
  "retry": {
    "enabled": false,
    "from_step": "embed_multichannel"
  }
}
```

失败时，界面只显示：

```text
素材处理失败
失败步骤：向量化
失败原因：provider timeout
操作：重试向量化
```

不要让员工在失败态里看到完整命令、API 参数、OSS URL 或 embedding 明细。
