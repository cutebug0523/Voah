---
name: voah-shot-retrieval
description: "视频混剪素材检索层：从 voah-video-intake 产物构建本地 story unit/shot 索引，默认读取 TTS 后的 audio_sections.json，按每段口播语义召回、rerank、重打点和填充素材；slot_plan 是旧回归路径。"
---

# Voah Shot Retrieval

## Scope

`voah-video-intake` 之后的素材检索层：

```text
intake run directory -> story unit index -> audio_sections.json -> multi-channel retrieval -> candidate_sections.json -> MiniMax M3 planner -> code validation/temporal fill -> timeline_selection.json / timeline_fill.json
```

本 skill 只负责从已入库素材里找可用 story unit / shot，并解释为什么选它；不负责写终稿文案、生成配音或渲染成片。

## Core Decisions

1. **先建本地索引**：MVP 使用本地 JSON + cosine，不急于接正式向量数据库。
2. **产品名做 metadata filter**：产品身份来自 intake 的路径/字段，不能靠语义相似度猜。
3. **多通道分开检索**：`video_chunk`、`visual_summary`、`source_meaning`、`asr`、`ocr`、`tags` 分通道打分，保留解释性。
4. **Embedding 只做粗召回**：`topK` 只负责给候选区间，不能直接当最终选片，否则同一文案会反复命中同一素材。
5. **MiniMax M3 候选池选片**：默认用 MiniMax M3 文本 LLM 在 `candidate_sections.json` 内选择 story unit / child 起点，处理多样性、上下文承接和选择理由。
6. **代码硬校验**：产品过滤、可渲染性、硬画面词、child physical shot 连续取片、不 loop、时长补齐、半开裁切和 fallback 都由代码负责，LLM 不能越权。
7. **Story Unit 优先**：混剪规划默认选 `story_units.json` 的同一段内容，避免把 1 秒级 physical shot 直接拼进成片。
8. **Physical Shot 是子单位**：story unit 负责规划，最终填充必须能追溯到 `child_physical_shot_id` 或 `source_start_offset_s/source_end_offset_s`。
9. **TTS 后召回**：默认按 `audio_sections[].voice_text/intention_copy/required_meaning` 检索，不再先选一排 shot 反向写稿。
10. **required_visual 硬词优先**：`车内`、`海边`、`泼水`、`测试卡` 等硬画面词优先级高于普通相似度、时长和复用惩罚。
11. **素材宜长不宜短**：长素材可裁；单个 child 不够长时，从命中 child 开始连续取同 story unit 内后续 child；仍不足再找同语义/同维度片段拼接，不默认循环凑够。
12. **输出候选和填充计划，不写文案**：结果要给后续时间线填充器使用，包括推荐时间段、适合角色、命中通道、风险和选择理由。

## Dependencies

- Python 3.9+
- `DASHSCOPE_API_KEY`：从环境变量或 `~/.voah/video_intake/.env` 读取
- DashScope Python SDK：用于把查询文本嵌入到 `qwen3-vl-embedding`
- `MINIMAX_API_KEY`：可选；存在时 `voah_retrieve_fill_from_audio_sections.py --selection-planner auto` 会启用 MiniMax M3 planner
- 输入来自 `voah-video-intake` run 目录

## Input Directory

默认读取某次 intake run 目录：

```text
cache/voah_video_intake/{product_slug}/{YYYYMMDD_HHMMSS}_intake/
```

必需文件：

- `story_units.json`（优先；不存在时回退到 `shots.json`）
- `assets.json`
- `embedding_results.json`

推荐文件：

- `physical_shots.json`（story unit 的子裁切单位，用于回溯/取子段）
- `shots.json`（语义父级，用于回溯）
- `segments.json`
- `moments.json`
- `vectorization_inputs.json`
- `trim_upload_results_physical.json`（优先；不存在时回退到 `trim_upload_results.json`）

## Output Files

写在同一个 intake run 目录下：

```text
shot_index.json
candidate_shots.json
```

`shot_index.json` 是本地检索索引；`candidate_shots.json` 是某次查询的候选列表。
`candidate_sections.json` 是按 `audio_sections.json` 分组的候选列表。
`slot_plan.json` 是旧的按固定混剪结构抓片产物，只用于 legacy 回归。

## Workflow

### 1. Build Local Index

用 `scripts/build_index.py` 从 intake 产物构建本地索引：

```bash
python3 /path/to/voah-shot-retrieval/scripts/build_index.py \
  --run-dir /path/to/intake_run
```

索引包含：

- product metadata
- story unit metadata
- child physical shot metadata (`child_physical_shot_ids`)
- child physical shot summaries (`child_physical_shots`)：包含 child id、时长、clip path、visual_summary/source_meaning/source_asr/source_ocr、风险字段
- parent semantic metadata (`parent_shot_id` / `semantic_shot_id`)
- usable range
- subtitle/TTS 风险字段
- 多通道 embedding
- channel mode/dim/status

默认 `build_index.py` 读取 `story_units.json`。只有做边界调试时才显式使用：

```bash
python3 /path/to/voah-shot-retrieval/scripts/build_index.py \
  --run-dir /path/to/intake_run \
  --granularity physical
```

### 2. Multi-Channel Retrieval

用 `scripts/search.py` 查询：

```bash
python3 /path/to/voah-shot-retrieval/scripts/search.py \
  --index /path/to/intake_run/shot_index.json \
  --query "防水防汗，适合放在卖点证明段" \
  --product "防晒气垫" \
  --role proof \
  --top-k 12 \
  --output /path/to/intake_run/candidate_shots.json
```

通道权重默认：

| channel | weight |
|---|---:|
| `source_meaning` | 1.00 |
| `visual_summary` | 0.85 |
| `tags` | 0.75 |
| `asr` | 0.55 |
| `ocr` | 0.45 |
| `video_chunk` | 0.35 |

说明：文本查询对文本通道更强；`video_chunk` 暂时作为辅助信号。后续如果输入是参考视频/图片，再提高视觉通道权重。

不同角色会使用不同默认权重：

- `opening`：更重 `visual_summary` / `video_chunk`，少信 ASR/OCR
- `product`：更重画面和原语义，适合找质地、上脸、前后对比
- `proof`：更重原语义、画面、标签，适合找测试和验证
- `cta`：提高 ASR/OCR 权重，允许福利、促销、下单信息进入排序

单 query 可加去重：

```bash
python3 /path/to/voah-shot-retrieval/scripts/search.py \
  --index /path/to/intake_run/shot_index.json \
  --query "防水防汗，适合放在卖点证明段" \
  --product "防晒气垫" \
  --role proof \
  --top-k 8 \
  --dedupe-parent \
  --pool-k 20 \
  --output /path/to/intake_run/candidate_shots_proof_deduped.json
```

### 3. Rule Rerank

规则 rerank 先处理这些字段：

- `product`：必须匹配，除非用户明确跨产品检索
- `selling_points` / `tags`：卖点命中加分
- `role`：opening/proof/product/cta/transition 等角色匹配加分
- `hard_subtitle_risk`：none/low 加分，medium/high 降分
- `voiceover_fit`：excellent/good 加分，fair/poor 降分
- `duration_s`：按目标时长加权
- `can_standalone`：开头/证明段优先 standalone

### 4. Audio-Section-Based Retrieval

当目标是混剪，不要把单 query `topK` 当最终选择。主线应读取 TTS 后的：

```text
audio_sections.json
```

每个 section 至少有：

```text
section_id
role
voice_text
intention_copy
required_meaning
required_visual
duration_s
```

召回与选片策略：

- 产品硬过滤
- 每个 section 用 `intention_copy + required_meaning + voice_text` 检索候选
- 写出 `candidate_sections.json`，把 story unit 候选、child physical shots、时长、硬字幕风险、相似度和命中理由都保留下来
- MiniMax M3 读取结构化候选池，在候选池内选择 story unit / child 起点，并解释选择和多样性理由
- 为避免按段调用时失去全片上下文，每段 MiniMax M3 prompt 必须携带 `previous_selections`，记录前面 section 已选 story unit / asset / child 起点摘要；LLM 仍不能越过候选池和代码硬校验。
- LLM 不直接裁片；代码继续校验产品、可渲染性、required_visual、时长、不 loop、child 连续取片和半开裁切
- LLM 失败或输出不合法时回退 `rules_text_planner_v1`，并在 `timeline_selection.json.policy.llm_fallback_reason` 和 `llm_selection_plan.safe.json` 记录原因
- 同一 section 优先找 required_visual/语义命中且足够长的 story unit
- 选中 story unit 后必须在 `child_physical_shots` 内定位真正使用的片段
- 如果单个 child physical shot 不够长，从命中 child 开始连续取同一 story unit 内的后续 child
- 如果单段素材短，优先找同语义/同维度候选拼接
- 每段候选要做 temporal rerank，输出真正可用 `child_physical_shot_id` 或 `source_start_offset_s/source_end_offset_s`
- 避免“只差一点点”就循环或硬拉伸
- 默认限制单个原片 asset 被过度使用，但允许同一原片连续段支撑同一语义 section
- 输出 `candidate_sections.json`、`llm_selection_plan.safe.json`、`timeline_selection.json` 和后续 `timeline_fill.json`

### 4.5 Legacy Slot-Based Rough Plan

`scripts/plan_slots.py` 可以按固定结构抓片：

```text
opening -> product -> proof -> cta
```

它用于 legacy 工具链回归和快速检查素材库，不是当前主线。主线是先有连续口播和 `audio_sections.json`，再按口播语义召回素材。

### 5. Candidate Output

每条候选必须包含：

- `rank`
- `shot_id`
- `story_unit_id`
- `parent_shot_id`
- `is_physical_shot`
- `is_story_unit`
- `planning_granularity`
- `asset_id`
- `label`
- `product`
- `time_range`
- `usable_range`
- `score`
- `channel_scores`
- `rerank_reasons`
- `risks`
- `retrieval_role`
- `child_physical_shot_ids`
- `child_physical_shots`
- `child_physical_shot_id`（进入 `timeline_selection` / `timeline_fill` 后必须存在，除非回退到 story unit clip 并标记 review）
- `source_start_offset_s` / `source_end_offset_s`
- `trimmed_clip_path` / `trimmed_oss_url`（如存在）

## QA Checklist

- 如果存在 `story_units.json`，默认索引记录数与 `story_units.json` 一致；否则与 `shots.json` 一致
- 每个索引记录至少有一个 embedding 通道
- `video_chunk` 如存在，必须是 `mode=video`
- story unit 候选必须保留 `child_physical_shot_ids`，便于最终裁切取子段
- story unit 候选应保留 `child_physical_shots` 摘要，不能只带 ids
- `timeline_selection.json` / `timeline_fill.json` 必须能解释最终裁切窗口来自哪个 child 或 offset
- 每次混剪应记录 intake boundary contract：`physical_shots.json`、`trim_end_epsilon_s`、`clip_frames`、`clip_actual_duration_s`
- 产品过滤不靠语义猜测
- 查询向量维度为 2560
- `candidate_shots.json` 至少包含分数、理由、风险、推荐时间段
- 主线产物应包含 `candidate_sections.json` 或等价按口播 section 分组的候选
- legacy `slot_plan.json` 的 `selected_timeline` 必须满足产品过滤，并尽量没有重复 `parent_shot_id`
- 不写入 API key
