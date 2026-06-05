# Voah 字幕样式与烧录记录

## 2026-06-05 字幕样式确认

本轮确认两个可用字幕 preset：

- `songti_white_gold_lower`：来自预览方案 1，宋体白金描边，下方安全区。
- `live_bar_lower`：来自预览方案 4，直播间口播条，下方安全区。

当前正式烧录优先用 `songti_white_gold_lower`。

## 字体策略

字体理论上可以替换，只要本机可访问即可。

更稳的工程化方式是：

1. 把目标字体文件复制到 HyperFrames 工程的 `fonts/`。
2. 在 `index.html` 中用 `@font-face` 指向该字体文件。
3. `caption_plan.json` 记录 `font_source`，方便干净 agent 或换机器复刻。

这样不会依赖系统字体名解析，也避免不同机器字体缺失导致字幕样式漂移。

## 关键词高亮

关键词变色可以批量做。

当前 HyperFrames 实现方式：

- 每句字幕在 `caption_plan.json` 中记录 `text` 与 `keywords`。
- HTML 渲染时按最长词优先匹配。
- 命中的词统一包成 `.highlight`，再套 preset 的高亮色。

注意：

- 每句建议高亮 1-3 个词。
- 不逐句手写 `<span>`。
- 产品卖点词、CTA、数字规格、强利益点优先进入关键词。

## 当前产物

- 样式预览工程：`/Users/noah/混剪/cache/voah_tasks/fangshai-qidian/20260605_164301_minimax_voice_audio_master_v1/hyperframes_style_preview/`
- 样式规则：`/Users/noah/混剪/cache/voah_tasks/fangshai-qidian/20260605_164301_minimax_voice_audio_master_v1/hyperframes_style_preview/subtitle_presets.json`
- 待烧录无字幕视频：`/Users/noah/混剪/cache/voah_tasks/fangshai-qidian/20260605_164301_minimax_voice_audio_master_v1/preview_no_subtitles.mp4`

## 字幕时间轴纠正

2026-06-05 的 `preview_scheme1_subtitled.mp4` 可以作为方案 1 字幕视觉样式参考，但不能作为字幕时间轴范式。

原因：

- TTS 文案是我们自己写的，字幕文本真源应来自 `voice_script.json`。
- MiniMax 返回的 `subtitle_file` 只有少量粗段，不适合作正式逐句字幕时间。
- 用 MiniMax 粗段再按字数拆 12 句，本质是伪对齐；TTS 的停顿、语气、数字读法和英文缩写会让字幕漂移。

正确策略：

```text
voice_script.json
  -> full_voice_text / script_sections 连续口播
  -> TTS 生成最终 voice.wav
  -> 按口播原文断句与语义分段生成 audio_sections.json
  -> caption_plan.json 继承每段时间，text 使用口播原文片段
```

如果必须一次性 TTS，则只能做 forced alignment：

```text
已知全文 + 最终音频 -> 求已知句子的时间戳
```

这里 ASR/Whisper/FunASR 只用于找时间锚点，不能作为字幕文本真源。

## 2026-06-05 全链路回归字幕烧录

本轮使用方案 1：

```text
preset: songti_white_gold_lower
font: hyperframes_subtitle_burn/fonts/Songti.ttc
position: lower_safe_area
caption_text_source: voice_script.json
timing_source: segmented_tts_duration_accumulation
```

产物：

```text
/Users/noah/混剪/cache/voah_tasks/fangshai-qidian/20260605_175355_full_pipeline_regression_v1/caption_plan.json
/Users/noah/混剪/cache/voah_tasks/fangshai-qidian/20260605_175355_full_pipeline_regression_v1/hyperframes_subtitle_burn/index.html
/Users/noah/混剪/cache/voah_tasks/fangshai-qidian/20260605_175355_full_pipeline_regression_v1/hyperframes_subtitle_burn/final_subtitled.mp4
```

HyperFrames 检查：

```text
npx hyperframes lint .
结果：0 errors, 1 warning
warning: timeline_track_too_dense，13 条字幕在同一轨道，当前可接受。

npx hyperframes inspect . --samples 12 --json
结果：ok，0 issues。
```

QA 截图：

```text
/Users/noah/混剪/cache/voah_tasks/fangshai-qidian/20260605_175355_full_pipeline_regression_v1/qa_frames/
```

注意：

- 字幕文本没有使用 MiniMax `subtitle_file`。
- 关键词高亮由 `caption_plan.json.captions[].keywords` 批量生成。
- `freezedetect` 在末段报 0.73 秒静止，但同样出现在无字幕版和源素材末段中，归类为源素材静帧风险。
- 该回归仍有一个已知错误：字幕 text 使用了短摘要版 `subtitle_text`，不是 TTS 实际口播原文断句，所以声音和字幕会“不逐字对上”。后续主线必须改成口播原文断句。
