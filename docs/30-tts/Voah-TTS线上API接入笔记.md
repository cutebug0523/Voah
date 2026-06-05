# Voah TTS 线上 API 接入笔记

## 1. 当前决定

TTS 后续优先使用线上 API，省掉本地 GPT-SoVITS 的部署和调参成本。本地 GPT-SoVITS 保留为回退方案，不再作为默认方向。

当前默认配置：

```text
provider: minimax-official
base_url: https://api.minimaxi.com
model: speech-2.8-hd
voice_id: moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d
speed: 1.1
emotion: happy
voice_modify: pitch=20, intensity=20, timbre=0
sync_endpoint: /v1/t2a_v2
upload_endpoint: /v1/files/upload
voice_clone_endpoint: /v1/voice_clone
```

API key 已写入本地 `.env` 的 `MINIMAX_API_KEY`；VectorEngine 的 key 仍保留为 TTS 代理/备用。skill 和脚本只读环境变量，不在 skill 里明文保存。

## 2. 官方 MiniMax 接口形态

同步 TTS：

```text
POST /v1/t2a_v2
```

核心字段：

```json
{
  "model": "speech-2.8-hd",
  "text": "口播文本",
  "stream": false,
  "language_boost": "Chinese",
  "output_format": "hex",
  "voice_setting": {
    "voice_id": "moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d",
    "speed": 1.1,
    "vol": 1,
    "pitch": 0,
    "emotion": "happy"
  },
  "voice_modify": {
    "pitch": 20,
    "intensity": 20,
    "timbre": 0
  },
  "audio_setting": {
    "sample_rate": 32000,
    "bitrate": 128000,
    "format": "mp3",
    "channel": 1
  }
}
```

异步 TTS：

```text
POST /v1/t2a_async_v2
GET  /v1/query/t2a_async_query_v2?task_id=...
```

异步会返回 `task_id` / `file_id`，任务成功后再用 File API 下载音频、字幕和 metadata。后续如果想用 TTS 自带句级时间戳做字幕，异步接口可能更合适。

同步 TTS 也支持字幕时间戳：

```json
{
  "subtitle_enable": true,
  "subtitle_type": "sentence"
}
```

成功响应的 `data.subtitle_file` 会给字幕 JSON 下载链接，句级时间戳单位为毫秒。Voah 可先保存这个 JSON 给后续字幕阶段，但是否烧录字幕由渲染阶段决定。

## 3. VectorEngine 映射

用户截图显示 VectorEngine 路径在官方 MiniMax 路径前加了 `/minimax`：

```text
POST https://api.vectorengine.ai/minimax/v1/t2a_v2
POST https://api.vectorengine.ai/minimax/v1/t2a_async_v2
```

同步 TTS 已按这个映射跑通；但声音克隆所需的文件上传代理暂时不可用，默认不要再走 VectorEngine 克隆路径。

## 4. 预置音色

先不做克隆。官方 system voice 或账号内可用 voice 都直接填 `voice_setting.voice_id`。

当前已用 curl 跑通的 voice_id：

```text
moss_audio_ce44fc67-7ce3-11f0-8de5-96e35d26fb85
```

注意：这条小样听感是男声，不作为带货默认音色。

适合带货女声的候选：

```text
Chinese (Mandarin)_Warm_Girl
Chinese (Mandarin)_Sweet_Lady
Chinese (Mandarin)_Crisp_Girl
Chinese (Mandarin)_Soft_Girl
Chinese (Mandarin)_IntellectualGirl
Chinese (Mandarin)_Warm_HeartedGirl
Chinese (Mandarin)_Laid_BackGirl
Chinese (Mandarin)_Warm_Bestie
```

更稳一点的候选：

```text
Chinese (Mandarin)_News_Anchor
Chinese (Mandarin)_Mature_Woman
Chinese (Mandarin)_Reliable_Executive
Chinese (Mandarin)_Wise_Women
Chinese (Mandarin)_Radio_Host
```

默认先试：

```text
Chinese (Mandarin)_Warm_Bestie
```

备选优先级：

```text
Chinese (Mandarin)_Warm_Bestie
Chinese (Mandarin)_Warm_Girl
Chinese (Mandarin)_Sweet_Lady
Chinese (Mandarin)_Crisp_Girl
female-tianmei-jingpin
```

2026-06-05 当前耳选基线：

```text
voice_id: moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d
speed: 1.1
emotion: happy
voice_modify.pitch: 20
voice_modify.intensity: 20
voice_modify.timbre: 0
```

对比结论：该官方女声比当前克隆声电子音更轻，适合作为 Voah 带货主线 TTS 默认配置。

## 5. 本地探测

2026-06-05 只探测了 voice list，不生成音频。

```text
POST https://api.vectorengine.ai/minimax/v1/get_voice
结果：200 text/html，返回 VectorEngine 的 minimax 页面，不是 JSON。

POST https://api.vectorengine.ai/v1/get_voice
结果：404 Invalid URL。
```

结论：

- VectorEngine 的 TTS endpoint 按截图继续测试。
- `get_voice` 暂时不能依赖 VectorEngine 代理层。
- 系统预置音色先按 MiniMax 官方静态 System Voice ID List 使用。

探测产物：

```text
/Users/noah/混剪/cache/voah_tts/vectorengine_minimax_probe/probe_summary.json
```

2026-06-05 已用同步 TTS 生成 1 条小样：

```text
endpoint: POST https://api.vectorengine.ai/minimax/v1/t2a_v2
model: speech-2.8-hd
voice_id: moss_audio_ce44fc67-7ce3-11f0-8de5-96e35d26fb85
text: 夏天出门补妆，一盒防晒气垫就够了。
result: success
audio: mp3, 32000 Hz, mono, 3.146s
```

产物：

```text
/Users/noah/混剪/cache/voah_tts/vectorengine_minimax_curl_test_20260605/sample_speech_2_8_hd.mp3
/Users/noah/混剪/cache/voah_tts/vectorengine_minimax_curl_test_20260605/sample_speech_2_8_hd.wav
/Users/noah/混剪/cache/voah_tts/vectorengine_minimax_curl_test_20260605/manifest.json
```

同日又生成了 8 条女声试听小样：

```text
/Users/noah/混剪/cache/voah_tts/minimax_female_voice_audition_20260605/audio
/Users/noah/混剪/cache/voah_tts/minimax_female_voice_audition_20260605/manifest.json
```

试听文案：

```text
夏天出门补妆，一盒防晒气垫就够了。轻轻一拍，防晒、遮瑕、提亮都安排上。
```

按带货可用性先听：

```text
05_Chinese_Mandarin__Warm_Bestie.mp3
02_Chinese_Mandarin__Warm_Girl.mp3
01_Chinese_Mandarin__Sweet_Lady.mp3
03_Chinese_Mandarin__Crisp_Girl.mp3
06_female-tianmei-jingpin.mp3
```

## 6. 对 Voah 管线的影响

TTS 阶段仍然只承接 `voice_script.json`，输出：

```text
voice.wav
tts_audio.json
```

变化是 `tts_audio.json` 需要记录线上 provider：

```json
{
  "provider": {
    "name": "vectorengine-minimax",
    "model": "speech-2.8-hd",
    "voice_id": "Chinese (Mandarin)_Warm_Bestie",
    "endpoint": "/minimax/v1/t2a_v2"
  }
}
```

不得记录 API key。

字幕阶段后续优先吃 TTS 真实音频的 ASR/时间戳；如果异步 TTS 能稳定拿到句级字幕，就让它直接导向 HyperFrames 字幕计划。

2026-06-05 回归后修正：

```text
默认字幕时间不吃 MiniMax subtitle_file。
默认先写连续口播并生成最终 voice.wav。
audio_sections.json 按口播原文的语义分段和 TTS 真实时间生成。
caption_plan.json 继承 audio_sections.json 的 start/end，text 使用口播原文断句。
```

本轮已跑通路径：

```text
/Users/noah/混剪/cache/voah_tasks/fangshai-qidian/20260605_175355_full_pipeline_regression_v1/voice.wav
/Users/noah/混剪/cache/voah_tasks/fangshai-qidian/20260605_175355_full_pipeline_regression_v1/tts_audio.json
/Users/noah/混剪/cache/voah_tasks/fangshai-qidian/20260605_175355_full_pipeline_regression_v1/audio_sections.json
```

关键 QA 结论：

- 13 段 TTS 总时长 43.92 秒。
- 旧的 `silenceremove` 误裁过部分 `.wav`，正式时间源改用 `*_raw.wav`。
- `tts_audio.json.qa.warnings` 必须记录这一类音频来源策略，避免后续误用被裁短的分段。
- 该回归是 legacy 分段 TTS 工具链证据；主线仍应先产出连续口播，再按口播语义做 audio_sections 和素材填充。

## 7. 声音克隆

更完整记录见：

```text
/Users/noah/混剪/docs/30-tts/Voah-TTS声音克隆调研.md
```

关键结论：

- 主克隆音频要求 mp3/m4a/wav，10 秒到 5 分钟，不超过 20 MB。
- 可选 `prompt_audio` 小于 8 秒，并且要给对应 `prompt_text`。
- 克隆产物是一个自定义 `voice_id`；后续 TTS 直接填 `voice_setting.voice_id` 复用。
- 生成后 7 天内必须用 T2A v2 或 T2A Large 真正合成一次音频来激活；`voice_clone` 的 preview 不算激活。
- 带明显 BGM 的音频不建议直接克隆，优先换干净单人口播语料。

2026-06-05 官方 MiniMax 直连已跑通上传、克隆、激活：

```text
base_url: https://api.minimaxi.com
upload: POST /v1/files/upload
clone: POST /v1/voice_clone
activation_tts: POST /v1/t2a_v2
voice_id: voah_a7cb2bf8_20260605_v1
activated: true
```

产物：

```text
/Users/noah/混剪/cache/voah_tts/voice_clone_sources/20260605_wechat_a7cb2bf8/minimax_official_clone_20260605_154055/clone_demo_audio.mp3
/Users/noah/混剪/cache/voah_tts/voice_clone_sources/20260605_wechat_a7cb2bf8/minimax_official_clone_20260605_154055/clone_activation_audio.mp3
```

manifest：

```text
/Users/noah/混剪/cache/voah_tts/voice_clone_sources/20260605_wechat_a7cb2bf8/voice_clone_manifest.json
```

2026-06-05 Apifox 文档实测：

```text
上传复刻音频: POST https://api.vectorengine.ai/minimax/v1/files
上传示例音频: POST https://api.vectorengine.ai/minimax/v1/files
音色快速复刻: POST https://api.vectorengine.ai/minimax/v1/voice_clone
```

上传字段：

```text
multipart/form-data
purpose=voice_clone 或 prompt_audio
file=@audio.mp3
```

当前 VectorEngine 阻塞：`/minimax/v1/files` 按文档请求会稳定返回 `response parsing failed`。`/minimax/v1/t2a_v2` 已验证可用，所以 VectorEngine 可作为 TTS 代理/备用，不作为默认声音克隆路径。

2026-06-05 跨通道复用测试：

```text
test: 用 VectorEngine /minimax/v1/t2a_v2 调用官方 MiniMax 克隆 voice_id
voice_id: voah_a7cb2bf8_20260605_v1
result: failed
base_resp.status_code: 2042
base_resp.status_msg: you don't have access to this voice_id
run_dir: /Users/noah/混剪/cache/voah_tts/vectorengine_official_clone_voiceid_test/20260605_155451
```

结论：官方 MiniMax 克隆音色不能拿到 VectorEngine 代理 key 下复用；克隆音色按账号/通道隔离。后续使用该克隆音色时默认走 `MINIMAX_BASE_URL=https://api.minimaxi.com` 和 `MINIMAX_API_KEY`。
