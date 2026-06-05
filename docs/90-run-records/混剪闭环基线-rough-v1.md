# 混剪闭环基线：rough v1

## 1. 文档目的

这份文档记录 2026-06-02 的第一版粗暴闭环。

后续 Voah 系列不再把入库当作每次任务的一部分。入库是常驻素材库建设；当前主线单次混剪任务从任务 brief / 产品卖点 / 销售逻辑开始，先生成连续口播和 TTS/audio_sections，再按口播语义召回素材。每一步都必须产出可被下一步读取的结构化文件。详见 `../00-overview/Voah系列工程化底座.md`。

它不是成品方案，而是后续优化的基线：

```text
素材选择
  -> 粗切片 / 向量化
  -> 粗打标
  -> 时间线规划
  -> 文案 / TTS / 字幕
  -> FFmpeg 渲染
  -> 人工质检
```

后续每次优化，都可以对照这条链路，判断到底是哪一环变好了。

## 2. 本轮产物

基础目录：

```text
/Users/noah/混剪/cache/remix_eval/fxl_cushion_rough_v1
```

关键路径：

```text
成片：
/Users/noah/混剪/cache/remix_eval/fxl_cushion_rough_v1/render/final/fxl_cushion_rough_v1.mp4

抽帧检查图：
/Users/noah/混剪/cache/remix_eval/fxl_cushion_rough_v1/render/final/screenshots/final_check_strip.jpg

素材联系图：
/Users/noah/混剪/cache/remix_eval/fxl_cushion_rough_v1/contact_sheet.jpg

素材清单：
/Users/noah/混剪/cache/remix_eval/fxl_cushion_rough_v1/manifest.json

索引明细：
/Users/noah/混剪/cache/remix_eval/fxl_cushion_rough_v1/rough_enriched_index.json

索引摘要：
/Users/noah/混剪/cache/remix_eval/fxl_cushion_rough_v1/rough_enriched_index_summary.json

渲染时间线：
/Users/noah/混剪/cache/remix_eval/fxl_cushion_rough_v1/rough_timeline_render.json

配音脚本：
/Users/noah/混剪/cache/remix_eval/fxl_cushion_rough_v1/voice_script.txt

TTS 音频：
/Users/noah/混剪/cache/remix_eval/fxl_cushion_rough_v1/audio/voice.m4a
```

记录文档：

```text
/Users/noah/混剪/docs/90-run-records/粗暴混剪测试记录.md
```

## 3. 本轮目标

目标是验证最小闭环是否能跑通：

```text
同一产品的 15-20 条素材
  -> 加入产品名和 CTA 维度
  -> 粗向量化 / 粗检索
  -> 自动生成配音文案
  -> TTS
  -> 上字幕
  -> FFmpeg 切割重构
  -> 输出一版混剪成片
```

目标产品：

```text
花西子气垫
```

本轮选择：

```text
素材池：/Users/noah/混剪/原片
数量：18 条最短竖屏素材
成片规格：720x1280，30fps，约 72.15 秒
```

## 4. 当前闭环

### 4.1 素材选择

输入：

```text
/Users/noah/混剪/原片
```

当前做法：

- 选取 18 条较短竖屏视频。
- 固定为同一产品测试：花西子气垫。
- 生成 manifest 和 contact sheet。

输出：

- `manifest.json`
- `manifest_assets.json`
- `contact_sheet.jpg`

当前问题：

- 只是按时长和竖屏素材选择，没有按画面质量、原字幕风险、产品露出、镜头可用性筛。
- 同源脚本和重复镜头没有严格去重。
- 没有先区分“可做主画面”“只适合 B-roll”“应避免使用”的素材。

后续优化：

- 加 `asset_quality_score`。
- 加 `hard_subtitle_risk`。
- 加 `duplicate_group_id`。
- 加 `primary_product_visibility`。
- 加 `usable_for_roles`，例如开场、产品亮相、上脸、证明、福利、CTA。

### 4.2 视频理解

当前做法：

- 本轮没有真正完成时间码级视频理解。
- 没有稳定产出 ASR、OCR、画面摘要、source_meaning。
- 角色主要来自模板式 enrichment。

上一轮粗索引看起来像这样：

```json
{
  "asset_id": "9f009f78",
  "start": 10.0,
  "end": 16.0,
  "product_name": "花西子气垫",
  "visual_role": ["遮瑕", "质地", "手背/粉扑演示"],
  "cta_terms": [],
  "enriched_text": "花西子气垫 ... 质地/遮瑕证明 遮瑕 质地 手背/粉扑演示 ..."
}
```

缺失的是：

```json
{
  "visual_summary": "实际画面描述",
  "source_ocr": "原硬字幕",
  "source_asr": "原口播",
  "source_meaning": "原片段本来表达的意思",
  "semantic_conflicts": [],
  "hard_subtitle_position": "bottom",
  "audio_reuse": "avoid|keep|mix_low"
}
```

当前问题：

- 这是最大问题。
- 视频理解不到位导致画面、配音、字幕不能语义对齐。
- 只知道“这个片段大概适合上脸/CTA”，不知道“这几秒到底在说什么”。
- 没有原文案作为语义锚点，后续文案容易凭空生成。

后续优化：

- 用 Omni 或 Qwen VL 生成时间码级理解。
- 每个 segment 生成 `source_meaning`。
- 原 OCR、ASR、画面摘要必须分字段保存。
- 生成 `voiceover_fit`，判断是否适合配新旁白。
- 生成 `subtitle_conflict`，判断原硬字幕是否影响新字幕。

### 4.3 向量化

当前做法：

- 使用 `qwen3-vl-embedding`。
- 18 条素材产出 142 个有效 chunk。
- 3 个过小 chunk 因 DashScope 视频体积下限失败。
- 每个 chunk 的 `enriched_text` 固定写入产品名和别名。
- CTA 只在 CTA 角色 chunk 上显式写入。

核验结果：

```text
asset_count: 18
chunk_count: 142
product_dimension: 所有 chunk 都写入“花西子气垫”及别名
cta_dimension: 29 个 chunk 带 CTA terms
```

角色分布：

```text
开场钩子: 18
产品亮相: 26
质地/遮瑕证明: 22
上脸效果: 28
套装/价值感: 19
CTA收尾: 29
```

当前问题：

- 主要是纯视频 chunk embedding + 手写 enriched_text。
- 没有 `source_meaning_embedding`。
- 没有 `asr_embedding` / `ocr_embedding`。
- 没有 `tag_embedding`。
- chunk 粗切和真实语义边界不一致。

后续优化：

- 多路向量化：
  - `video_chunk_embedding`
  - `clip_summary_embedding`
  - `source_meaning_embedding`
  - `asr_embedding`
  - `ocr_embedding`
  - `tag_embedding`
- 向量库 metadata 必须带：
  - product_name
  - selling_points
  - cta_terms
  - visual_actions
  - shot_type
  - hard_subtitle_risk
  - usable_start / usable_end
- 检索结果必须进入 rerank，不能直接剪。

### 4.4 时间线规划

当前做法：

- 使用固定结构：

```text
开场钩子
  -> 产品亮相
  -> 质地/遮瑕
  -> 上脸效果
  -> 套装/价值感
  -> CTA
```

- 18 条素材各取一个片段。
- 时间线字段实际使用 `role` / `source_role`。

当前问题：

- 时间线不是由真实视频理解驱动，而是按模板硬分配。
- 没有用文案意图去召回素材。
- 没有 temporal rerank 重新打可用时间点。
- 没有根据镜头边界、ASR 句子边界、字幕闪烁点做 cut snap。

后续优化：

- 先生成 `script_slots`：

```json
{
  "slot": 3,
  "role": "质地证明",
  "intention_copy": "展示气垫质地轻薄，拍开不厚重",
  "target_duration": 4.0,
  "target_chars": 18,
  "required_meaning": ["轻薄", "不厚重", "服帖"]
}
```

- 每个 slot 召回候选素材。
- Omni / VLM 输出 `usable_start` / `usable_end`。
- 代码校验剪点是否越界、是否太短、是否切断动作或句子。

### 4.5 文案生成

当前做法：

- 先写完整带货脚本。
- 再把脚本句子塞到时间线片段里。
- 文案没有充分参考原素材的 ASR / OCR / source_meaning。

当前问题：

- 文案整体性有了，但和画面未必匹配。
- 原素材本来的语义没被利用。
- 某段画面可能只是产品特写，但新文案在讲上脸或福利。
- 这导致声音、字幕、画面各玩各的。

后续优化：

文案必须分三层：

```text
source_meaning：素材本来表达什么
intention_copy：本次成片这个位置想表达什么
final_voice_text：根据已选画面最终说什么
```

推荐流程：

```text
先用 source_meaning 拼结构
  -> 生成 intention_copy
  -> 匹配并固定画面
  -> 再让 LLM 重写 final_voice_text
```

最终文案需要校验：

- 是否保留选中片段的原始核心语义。
- 是否和画面动作一致。
- 是否和原硬字幕冲突。
- 是否满足 `target_chars`。
- 前后句是否顺滑。

### 4.6 TTS

当前做法：

- 使用 macOS `say -v Tingting` 生成粗测配音。
- 输出 `audio/voice.m4a`。

当前问题：

- 声音机械。
- 语速、情绪、停顿不可控。
- 为了贴合音频长度，把画面扩展到约 72 秒，偏离原 45 秒目标。

后续优化：

- TTS 引擎后置，不应影响核心判断。
- 先解决视频理解和文案对齐。
- 后续可以接更自然的 TTS。
- TTS 生成后要反向校验每段音频时长，必要时重写句子而不是拉长画面。

### 4.7 字幕

当前做法：

- 当前 ffmpeg 缺少 `subtitles`、`drawtext`、`ass` filter。
- 使用 Pillow 生成透明 PNG 字幕。
- 每个片段单独 overlay，再 concat。

当前问题：

- 原素材大多自带硬字幕。
- 新字幕会和原字幕撞位。
- 字幕现在只是“能显示”，不是成片级排版。

后续优化：

- 视频理解阶段记录原硬字幕位置。
- 对每个片段生成字幕风险：

```text
keep：原字幕可保留
avoid：尽量不用该片段
crop：裁切原字幕区域
cover：遮挡原字幕
move_new_caption：新字幕避让
```

- 字幕策略暂时不是第一优先级，但必须进入 metadata。

### 4.8 渲染

当前做法：

- FFmpeg 切割每个片段。
- 统一转成 720x1280 / 30fps。
- 每段 overlay 字幕。
- concat 成无声视频。
- 合成 TTS 音频。

当前问题：

- 渲染本身可行。
- 但环境缺少字幕 filter，导致字幕路线绕了一圈。
- 之前全局 18 层 overlay 很慢，后改成逐片 overlay 再 concat。

后续优化：

- 固化渲染能力探测：
  - 是否支持 `drawtext`
  - 是否支持 `subtitles`
  - 是否支持 `ass`
  - 是否支持硬件加速
- timeline render 前先选择字幕渲染策略。
- 保留逐片渲染路线作为兼容 fallback。

### 4.9 质检

当前做法：

- ffprobe 检查成片规格。
- 抽 2s、18s、36s、55s、70s 生成截图。
- 拼成 `final_check_strip.jpg` 人工查看。

确认结果：

- 成片非空。
- 有配音和字幕。
- 产品、人物、活动、上脸画面都有。
- 原硬字幕和新字幕撞位明显。

后续优化：

- 自动生成质检报告：
  - 黑屏检测
  - 音频存在检测
  - 字幕可见性检测
  - 原字幕冲突检测
  - 产品露出抽帧检测
- 每版成片生成 sidecar QA JSON。

## 5. 本轮最重要的失败点

最大问题不是字幕，也不是 TTS。

最大问题是：

```text
视频理解不到位，导致画面 / 声音 / 字幕没有围绕同一个 source_meaning 对齐。
```

具体表现：

- 素材片段不知道自己原来在讲什么。
- 文案不是从原片段语义里长出来的。
- 时间线不是由真实片段语义驱动。
- 新配音和新字幕虽然完整，但像被贴在画面上。

因此下一轮不应先优化 TTS 或字幕，而应先优化：

```text
视频理解
  -> source_meaning
  -> 多路向量化
  -> 意图文案召回
  -> temporal rerank
  -> 最终文案重写
```

## 6. 后续优化顺序

### P0：素材理解与结构化

必须先做：

- segment schema。
- Omni / Qwen VL 结构化理解 prompt。
- ASR / OCR / visual_summary / source_meaning 分字段。
- 原硬字幕风险记录。

### P1：素材向量化

在 P0 基础上做：

- 多路 embedding。
- ChromaDB / SQLite metadata schema。
- 检索融合策略。
- 同源去重和镜头去重。

### P2：文案与时间线

在可检索素材基础上做：

- `script_slots` 生成。
- `intention_copy` 召回。
- temporal rerank。
- `final_voice_text` 二次重写。

### P3：字幕和 TTS

等画面语义对齐后再优化：

- 更自然 TTS。
- 字幕排版。
- 原硬字幕避让 / 遮挡 / 裁切。

### P4：渲染和质检自动化

最后固化：

- render engine。
- QA report。
- 成片版本对比。

## 7. 下一轮评估标准

下一轮不要只看“能不能出片”，要看：

- 每个片段是否有可信 `source_meaning`。
- 文案是否能追溯到对应片段的原语义。
- 每句最终配音是否和当前画面一致。
- 原字幕是否被识别并纳入风险判断。
- 时间点是否真的切在可用动作/句子上。
- 是否减少“画面/声音/字幕各玩各的”。

建议下一版先只处理 3-5 条素材，不急着做 18 条全量。

目标不是再出一版更漂亮的视频，而是验证：

```text
source_meaning -> intention_copy -> candidate retrieval -> temporal rerank -> final_voice_text
```

这条链路是否成立。

## 8. 已落地 Skill

第一版视频入库 skill 已落地：

```text
/Users/noah/.codex/skills/voah-video-intake/SKILL.md
```

模型、Key、本地临时 OSS 上传方案在：

```text
/Users/noah/.codex/skills/voah-video-intake/references/model-and-upload-config.md
```

本地 Key 保存脚本：

```text
/Users/noah/.codex/skills/voah-video-intake/scripts/save_dashscope_key.py
```

默认 Key 保存位置：

```text
~/.voah/video_intake/.env
```

Skill 名称：

```text
voah-video-intake
```

它当前负责：

- 从路径 / 文件夹读取产品主键，而不是让模型猜产品。
- 用 ffprobe 获取视频物理元信息。
- 先创建逻辑粗窗口，不急着物理切碎素材。
- 用 Omni / VLM 做结构化理解。
- 维护 Asset -> Story Segment -> Shot -> Moment 层级。
- 产出 `source_meaning`、`visual_summary`、`source_asr`、`source_ocr`、`usable_start` / `usable_end` 等字段。
- 为后续多路向量化准备输入。

默认产物根路径：

```text
/Users/noah/混剪/cache/voah_video_intake/
```

默认单次运行目录：

```text
/Users/noah/混剪/cache/voah_video_intake/{product_slug}/{YYYYMMDD_HHMMSS}_{run_label}/
```

单次运行目录里建议包含：

```text
run_manifest.json
manifest.json
assets.json
segments.json
shots.json
moments.json
vectorization_inputs.json
contact_sheet.jpg
understanding_raw/
probe/
windows/
frames/
qa_report.json
```

它暂时不负责：

- 最终脚本生成。
- TTS。
- 字幕排版。
- FFmpeg 成片渲染。

后续如果要实现脚本或 MCP，优先围绕这个 skill 的 schema 和 QA checklist 展开。
