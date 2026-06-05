# Voah 系列工程化底座

## 1. 基本定位

Voah 不是一次性脚本集合，而是一条可持续迭代的混剪工程管线。

核心拆法：

```text
常驻素材库
  -> 单次任务流水线
```

`voah-video-intake` 属于常驻素材库建设。它负责把原片变成可检索、可复用、可追溯的资产，不属于每次混剪任务的正文阶段。

一次具体混剪任务从任务 brief 和销售逻辑开始：

```text
任务 brief / 产品卖点 / 平台目标
  -> 文案第一步：销售逻辑与脚本意图
  -> 文案第二步：连续口播稿
  -> TTS
  -> audio_sections
  -> 按口播语义召回/重打点素材
  -> 字幕
  -> 时间线渲染
  -> QA / 复盘
```

如果任务开始时素材还没入库，应先把入库当作“素材库维护”单独跑完，产出可复用的 intake run；然后任务从 task brief / 产品卖点 / 销售逻辑开始。召回发生在连续口播和 TTS/audio_sections 之后。

## 2. 常驻层与任务层

### 2.1 常驻素材库

常驻层产物可以被多个任务重复使用。

当前代表产物：

```text
cache/voah_video_intake/{product_slug}/{YYYYMMDD_HHMMSS}_intake/
```

典型文件：

```text
assets.json
shots.json
physical_shots.json
embedding_results.json
shot_index.json
trimmed_physical/
run_manifest.json
```

常驻层关注：

- 产品身份
- 原始素材路径
- 语义 shot
- 物理 shot
- OCR / ASR / 画面摘要 / source_meaning
- 多通道 embedding
- 可回溯的模型和参数
- 可被后续任务检索的索引

常驻层不负责：

- 本次成片主题
- 本次文案风格
- 本次镜头顺序
- 本次 TTS 和字幕
- 本次最终渲染

### 2.2 单次任务流水线

任务层产物只服务某一次混剪目标。

建议路径：

```text
cache/voah_tasks/{product_slug}/{YYYYMMDD_HHMMSS}_{task_slug}/
```

任务层从任务 brief 开始，最小闭环：

```text
task_brief
  -> copy_brief / sales_logic
  -> copy_final
  -> voice
  -> audio_sections
  -> retrieval / temporal_rerank
  -> timeline
  -> subtitle
  -> render
  -> qa
```

任务层必须显式引用使用了哪一次常驻入库产物，例如：

```json
{
  "source_intake_run": "/Users/noah/混剪/cache/voah_video_intake/fangshai-qidian/20260603_002146_intake",
  "source_index": "/Users/noah/混剪/cache/voah_video_intake/fangshai-qidian/20260603_002146_intake/shot_index.json"
}
```

## 3. 产物合同

每一步都必须有明确产物，不能只靠聊天上下文或临时变量传递。

每个步骤产物至少包含：

```json
{
  "schema_version": "1.0.0",
  "stage": "retrieval",
  "created_at": "2026-06-03T01:40:00+0800",
  "product": {
    "name": "防晒气垫",
    "slug": "fangshai-qidian"
  },
  "inputs": {
    "source_index": "/absolute/path/shot_index.json"
  },
  "outputs": {
    "next_artifact": "/absolute/path/copy_brief.json"
  },
  "qa": {
    "status": "ok",
    "warnings": []
  },
  "next_consumers": ["voah-copy-brief"]
}
```

原则：

- 输入必须是文件路径或结构化配置。
- 输出必须是文件，且后续步骤能直接读取。
- 每一步要写 `schema_version`，后续可迁移。
- 每一步要写 `inputs`，保证可追溯。
- 每一步要写 `qa`，保证不是盲传。
- 每一步要写 `next_consumers` 或等价说明，保证导向下一步。

## 4. 当前阶段产物链

### 4.1 文案第一步

输入：

```text
task_brief.json
product_claims.json
```

输出：

```text
copy_brief.json
```

用途：

- 定全片销售逻辑、卖点顺序、证明方式和 CTA。
- 生成 `script_sections` / `intention_copy`，给 TTS 后的素材召回使用。
- 不在这里先固定具体 shot。

### 4.2 文案第二步

建议输出：

```text
voice_script.json
```

定位：

连续口播稿和字幕文本真源。

它读取 `copy_brief.json`，生成一条完整、顺滑、可直接 TTS 的销售口播：

```text
full_voice_text
pronounce_text
script_sections[].voice_text
subtitle_policy = verbatim_voice_text_split
```

### 4.3 TTS 与音频主轴

建议输出：

```text
voice.wav
tts_audio.json
audio_sections.json
```

定位：

最终音频和后续素材填充/字幕的时间轴。

`audio_sections.json` 应按口播语义分段。可以用分段 TTS、标点比例、TTS 字幕或 forced alignment 辅助定时，但文本仍必须来自口播原文。

### 4.4 召回与素材填充

输入：

```text
audio_sections.json
shot_index.json
```

输出：

```text
candidate_sections.json
timeline_fill.json
preview_no_subtitles.mp4
```

定位：

按每段口播语义和时长召回素材，做 temporal rerank 和可用剪点确认。

原则：

```text
素材宜长不宜短。
长素材可剪。
短素材优先同语义/同维度拼接。
不要默认用循环填“只差一点点”的时长。
```

### 4.5 后续阶段

建议产物：

```text
tts_audio.json / voice.wav
audio_sections.json
timeline_fill.json
caption_plan.json
hyperframes_subtitle_burn/
full_pipeline_manifest.json
final_subtitled.mp4
qa_report.json
```

每个文件都必须能解释自己从哪里来、给谁用。

当前确认的后半段任务合同：

```text
voice_script.json
  -> tts_audio.json / voice.wav / audio_sections.json
  -> candidate_sections.json / timeline_fill.json / preview_no_subtitles.mp4
  -> caption_plan.json
  -> hyperframes_subtitle_burn/index.html
  -> hyperframes_subtitle_burn/final_subtitled.mp4
  -> full_pipeline_manifest.json
```

2026-06-05 全链路回归路径：

```text
cache/voah_tasks/fangshai-qidian/20260605_175355_full_pipeline_regression_v1/
```

该回归覆盖了工具链，但属于 legacy 路径：

- 从已有 `slot_plan.json` 继续，不重入库。
- `copy_brief.json` 和 `voice_script_skill.json` 保留 skill 回归证据。
- 手工校准 `voice_script.json` 接管下游，因为当前 copy-final skill 的自然文案质量仍不够。
- MiniMax 官方女声固定参数生成 13 段 TTS。
- 用 `*_raw.wav` 组装 `voice.wav`，总长 43.92 秒。
- 视频按每段音频时长裁切/循环，输出无字幕预览。
- HyperFrames 用 `caption_plan.json` 烧录方案 1 字幕。
- `full_pipeline_manifest.json` 汇总 QA、warning 和下一步优化点。

不能把该回归当主线范式，因为它是 `slot_plan -> 逐 shot 写稿 -> TTS -> 填视频`。主线范式是 `连续口播 -> TTS/audio_sections -> 按口播语义召回/填充素材`。

## 5. Skill 设计约束

Voah 系列 skill 必须遵守：

- 一个 skill 只负责一个阶段或一个清晰能力域。
- 每个 skill 的 `SKILL.md` 要写明输入文件、输出文件和下一步。
- 脚本不能把重要结果只打印到终端，必须写入产物文件。
- skill 可以调用模型，但模型结果要结构化落盘。
- 如果缺少上一步产物，先提示需要哪个产物；不要凭空跳步。
- 临时测试文件可以存在，但正式链路必须有稳定路径和 manifest。

## 6. 当前结论

Voah 的底座不是“模型一次性生成混剪”，而是：

```text
常驻素材库负责记住素材
任务流水线负责一步一步生产成片
每一步用产物承接上一环并导向下一环
```

这条原则优先级高于单个模型、单个脚本和单个 prompt。
