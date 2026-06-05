# MoneyPrinterTurbo 对 Voah 的启发

调研对象：

```text
https://github.com/harry0703/MoneyPrinterTurbo
```

本地研究副本：

```text
/Users/noah/混剪/_research/MoneyPrinterTurbo
```

研究 commit：

```text
788f52a292edbf76c5495e0d05562c2851ed75b4
2026-06-02 17:41:38 +0800
Sync Chinese README documentation cleanup
```

## 1. 项目定位

MoneyPrinterTurbo 是“主题生成短视频”的完整工厂：

```text
主题/关键词
  -> LLM 文案
  -> 搜索词
  -> TTS
  -> 字幕
  -> 在线/本地素材
  -> 视频拼接
  -> 字幕+BGM+音频合成
  -> final.mp4
```

Voah 的定位不同：

```text
已入库商品素材
  -> shot 召回
  -> 商品混剪结构
  -> 两步文案
  -> TTS
  -> 字幕
  -> 精确时间线渲染
```

所以它不是 Voah 的替代品，但它提供了几个非常值得吸收的工程边界。

## 2. 最值得借鉴的结构

### 2.1 stop_at 可停止点

MoneyPrinterTurbo 的 `app/services/task.py` 把主流程拆成可停止节点：

```text
script
terms
audio
subtitle
materials
video
```

每个节点都能单独结束并更新任务状态。

Voah 应该吸收这个设计，把 skill 链从“靠聊天顺序推进”升级成“可恢复任务流水线”：

```text
retrieval
copy_brief
copy_final
tts
duration_reconcile
subtitle
timeline
render
qa
```

每一阶段都应该允许：

- 只跑到本阶段
- 从本阶段继续
- 本阶段失败后只重跑本阶段
- 用结构化 manifest 解释为什么进入下一阶段

这和我们已经定下的“每一步必须有产物”是一致的，但 MoneyPrinterTurbo 的启发是：可以再加一个统一的任务控制层。

### 2.2 任务状态与进度

MoneyPrinterTurbo 有 `state.py`，支持内存状态和 Redis 状态，任务状态包含：

```text
task_id
state
progress
outputs
```

Voah 目前更像“文件产物链”，这没问题，但后面如果要批量跑、子 agent 跑、Crab/Codex 双端跑，最好补一个轻量任务状态文件：

```text
task_state.json
```

建议字段：

```json
{
  "task_id": "20260603_45s_v1",
  "product": {"name": "防晒气垫", "slug": "fangshai-qidian"},
  "current_stage": "tts",
  "state": "warning",
  "progress": 45,
  "artifacts": {
    "slot_plan": ".../slot_plan.json",
    "copy_brief": ".../copy_brief.json",
    "voice_script": ".../voice_script.json",
    "tts_audio": ".../tts_audio.json"
  },
  "warnings": []
}
```

这不是替代每个阶段 manifest，而是给外层调度器一个快速索引。

### 2.3 API 参数模型

MoneyPrinterTurbo 用 `VideoParams` 把文案、素材、TTS、字幕、尺寸、BGM 都收进一个参数模型。

Voah 不应该照搬一个巨大的请求体，但可以拆成几个稳定 contract：

```text
VoahTaskConfig
VoahRetrievalConfig
VoahTTSConfig
VoahSubtitleConfig
VoahRenderConfig
```

这样 skill 不必每次从自然语言里猜参数。

### 2.4 combined 与 final 分离

MoneyPrinterTurbo 先产出：

```text
combined-1.mp4
```

再产出：

```text
final-1.mp4
```

前者是视频素材拼接，后者才是音频、字幕、BGM 合成后的成片。

Voah 也应该这么拆：

```text
timeline_video.mp4
  -> final.mp4
```

好处：

- 可以单独检查镜头顺序是否合理
- 可以单独检查音频/字幕是否对齐
- 出问题时不用整条链重跑

### 2.5 字幕不是单一步骤

MoneyPrinterTurbo 的字幕链路有两种：

```text
TTS provider 自带边界
Whisper 转写 fallback
```

并且会用脚本文本修正字幕。

Voah 这点尤其重要：字幕文本应该来自 `voice_script.json`，时间最好来自 TTS 音频转写或 TTS 边界。

建议链路：

```text
voice_script.json
tts_audio.json / voice.wav
  -> transcript.json
  -> subtitles.srt / subtitles.ass
```

字幕阶段不应该重新写文案，只负责：

- 给已有口播定时
- 把识别结果纠偏回 `subtitle_lines`
- 标记识别不一致的风险

### 2.6 本地素材安全与可读性校验

MoneyPrinterTurbo 对本地素材做了几个很实用的保护：

- 只允许读取指定素材目录
- 检查图片/视频能否被打开
- 过滤过低分辨率素材
- 图片转成短视频片段
- 处理坏 EXIF / 元数据

Voah 的素材入库目前已经更强，但渲染阶段仍可吸收：

- 渲染前检查所有 `trimmed_clip_path` 存在
- ffprobe 检查每个 clip 的时长、分辨率、是否可读
- 对短 clip / 图片素材做明确 fallback
- 每个渲染失败 clip 都写入 `render_manifest.json`

### 2.7 FFmpeg concat 优先

MoneyPrinterTurbo 没有完全依赖 MoviePy 拼接，关键拼接用了 ffmpeg concat，并做编码器 fallback：

```text
h264_videotoolbox / nvenc / qsv ...
  -> libx264 fallback
```

Voah 后面渲染时应该优先用 ffmpeg 的确定性能力：

```text
精确裁切
concat
音频混合
字幕烧录或 overlay
```

HyperFrames 可以负责更复杂的字幕视觉、动效和包装，但底层片段拼接不要过度依赖浏览器渲染。

## 3. 不能照搬的地方

### 3.1 它是主题视频，不是商品混剪

MoneyPrinterTurbo 的素材逻辑是：

```text
LLM 生成搜索词
  -> Pexels/Pixabay 找泛素材
  -> 按音频时长随机/顺序拼够
```

Voah 的素材逻辑是：

```text
商品素材库
  -> 产品 metadata filter
  -> shot 多通道召回
  -> slot 结构约束
  -> 画面/原语义/口播对齐
```

所以不能借它的“搜索词找素材”作为核心，只能借它的任务阶段和渲染工程。

### 3.2 它缺少视频理解层

MoneyPrinterTurbo 对本地素材基本只做可读性和分辨率处理，不理解：

- 画面是什么
- 原字幕是什么
- 原 ASR 表达什么
- 当前 shot 适合承担什么功能
- 是否有硬字幕冲突

这恰好是 Voah 的核心壁垒。我们的 `voah-video-intake` 不能退化成它那种素材池拼接。

### 3.3 随机拼接不适合带货素材

MoneyPrinterTurbo 会按音频长度循环或补齐素材。泛知识短视频可以这么做，但带货混剪不能。

Voah 必须保留：

- 开场不能直接 CTA
- 产品介绍早于福利
- 实验/防水/户外证明要在产品价值后
- CTA 收尾
- 每段口播能对上当前画面

所以 Voah 的 render 阶段不能随便 loop clips，而应让上游 `duration_reconcile` 决定：

```text
压文案
扩时间线
重选 shot
调整 clip speed
```

## 4. 对当前 Voah skill 链的直接建议

### 4.1 新增 voah-task-runner

MoneyPrinterTurbo 最大启发是外层编排。

建议后面新增：

```text
voah-task-runner
```

职责：

- 读取 `task_config.json`
- 检查当前任务目录已有产物
- 按阶段顺序调用对应 skill 脚本
- 支持 `--stop-at`
- 支持 `--resume-from`
- 写 `task_state.json`

示例：

```bash
python3 run_voah_task.py \
  --task-dir cache/voah_tasks/fangshai-qidian/20260603_45s_v1 \
  --stop-at subtitle
```

### 4.2 新增 voah-duration-reconcile

这一步现在已经被 TTS 暴露出来了：

```text
素材时间线：47.034s
TTS 音频：69.04s
```

MoneyPrinterTurbo 是让视频去匹配音频时长；Voah 不能直接这么干。

建议新增：

```text
voice_script.json + tts_audio.json + slot_plan.json
  -> duration_plan.json
```

它只做决策，不渲染：

```text
方案 A：压缩文案重配
方案 B：保留口播，扩展时间线
方案 C：局部变速/局部补 shot
```

对于带货混剪，默认优先级应是：

```text
先压文案
再重配音
最后才扩时间线
```

### 4.3 新增 voah-subtitle

参考 MoneyPrinterTurbo 的字幕纠偏思路，但文本源改成 Voah 的 `subtitle_lines`。

输入：

```text
voice_script.json
tts_audio.json
voice.wav
```

输出：

```text
transcript.json
subtitles.srt
subtitles.ass
```

必须检查：

- 转写文本是否接近 `full_voice_text`
- 每条字幕是否能对应 `script_items`
- 有没有识别错的营销词，比如 SPF、六一八
- 字幕总时长是否等于音频时长

### 4.4 新增 voah-render

参考 MoneyPrinterTurbo 的 `combined -> final` 两段式：

```text
timeline.json
  -> timeline_video.mp4
  -> final.mp4
```

输入：

```text
slot_plan.json
voice_script.json
tts_audio.json
subtitles.ass
```

输出：

```text
timeline.json
timeline_video.mp4
final.mp4
render_manifest.json
```

MVP 可以先用 ffmpeg：

- concat 选中 clip
- 挂载 voice.wav
- 烧录字幕
- 输出 final.mp4

HyperFrames 更适合后续做：

- 字幕动效
- 标题卡
- 商品信息贴片
- 视觉包装

## 5. 建议后的 Voah 任务链

当前链路：

```text
slot_plan.json
  -> copy_brief.json
  -> voice_script.json
  -> voice.wav / tts_audio.json
```

建议补全为：

```text
task_config.json
  -> slot_plan.json
  -> copy_brief.json
  -> voice_script.json
  -> voice.wav
  -> tts_audio.json
  -> duration_plan.json
  -> transcript.json
  -> subtitles.ass
  -> timeline.json
  -> timeline_video.mp4
  -> final.mp4
  -> qa_report.json
```

其中：

- `task_config.json`：任务入口
- `task_state.json`：任务外层状态
- 每个阶段 manifest：阶段自己的真源

## 6. 结论

MoneyPrinterTurbo 对 Voah 最有价值的不是素材算法，而是工程化骨架：

```text
阶段清晰
可 stop_at
可查询状态
音频/字幕/素材/渲染分层
combined 与 final 分离
渲染前做素材校验
字幕用脚本文本纠偏
```

Voah 应该继续坚持自己的核心：

```text
先理解商品素材
shot 精确分片
产品 metadata filter
slot 结构约束
两步文案
TTS 后做时长校准
字幕和画面最终对齐
```

下一步最值得做的是：

```text
voah-duration-reconcile
voah-subtitle
voah-render
voah-task-runner
```

顺序建议：

```text
先做 duration_reconcile
再做 subtitle
再做 render
最后做 task_runner
```

原因是当前真实 blocker 是 TTS 时长和素材时间线不一致；如果不先解决，字幕和渲染都会被带偏。
