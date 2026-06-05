# Voah TTS 声音克隆调研

## 1. 结论

MiniMax 声音克隆适合接入 Voah。2026-06-05 已用官方 MiniMax 直连跑通上传、克隆、TTS 激活；默认克隆音色为 `voah_a7cb2bf8_20260605_v1`。

但不要直接拿带明显 BGM 的混剪视频音轨做最终声纹源。本次微信视频音轨可用于流程测试，商业化前建议换更干净的单人口播语料。

推荐流程：

```text
干净人声素材
  -> 提取/裁剪 10-60 秒主音频
  -> 可选：小于 8 秒 prompt_audio + 对应 prompt_text
  -> 上传 source audio 得到 file_id
  -> voice_clone 生成自定义 voice_id
  -> 7 天内用 T2A v2 真正合成一次来激活
  -> 后续 TTS 统一用 voice_setting.voice_id 复用
```

## 2. 官方素材要求

主克隆音频：

```text
格式：mp3 / m4a / wav
时长：至少 10 秒，最多 5 分钟
大小：不超过 20 MB
用途字段：purpose=voice_clone
```

可选提示音频：

```text
格式：mp3 / m4a / wav
时长：小于 8 秒
大小：不超过 20 MB
用途字段：purpose=prompt_audio
需要同时提供对应文本 prompt_text
```

`clone_prompt` 不是必需项，但官方说明它能提升相似度和稳定性。若使用，`prompt_audio` 和 `prompt_text` 必须同时提供。

## 3. 接口链路

上传主音频：

```bash
curl --request POST \
  --url https://api.minimaxi.com/v1/files/upload \
  --header "Authorization: Bearer $MINIMAX_API_KEY" \
  --form purpose=voice_clone \
  --form file=@clone_input.mp3
```

上传可选提示音频：

```bash
curl --request POST \
  --url https://api.minimaxi.com/v1/files/upload \
  --header "Authorization: Bearer $MINIMAX_API_KEY" \
  --form purpose=prompt_audio \
  --form file=@clone_prompt.mp3
```

克隆：

```json
{
  "file_id": 123456789,
  "voice_id": "voah_xxx_20260605",
  "clone_prompt": {
    "prompt_audio": 987654321,
    "prompt_text": "对应提示音频文本"
  },
  "text": "这是一段用于试听克隆音色的短文案。",
  "model": "speech-2.8-hd",
  "language_boost": "Chinese",
  "need_noise_reduction": true,
  "need_volume_normalization": true
}
```

VectorEngine Apifox 实测映射是：

```text
POST https://api.vectorengine.ai/minimax/v1/files
POST https://api.vectorengine.ai/minimax/v1/voice_clone
```

Apifox 文档站定位信息：

```text
doc site onlineId: 5468241
projectId: 7109750
branchId: 6832198

上传复刻音频: api 421110419, POST /minimax/v1/files
上传示例音频: api 421110420, POST /minimax/v1/files
音色快速复刻: api 421110422, POST /minimax/v1/voice_clone
```

上传复刻音频的 request body：

```text
multipart/form-data
purpose=voice_clone
file=@clone_input.mp3
```

上传示例音频的 request body：

```text
multipart/form-data
purpose=prompt_audio
file=@prompt_input.mp3
```

2026-06-05 实测结论：`/minimax/v1/files` 文档字段确认无误，但 VectorEngine 代理当前稳定返回：

```json
{
  "task_id": "",
  "status": "error",
  "base_resp": {
    "status_code": 1,
    "status_msg": "response parsing failed"
  }
}
```

已排除的变量：

```text
curl 与 Python requests 均复现
ASCII filename / 显式 audio/mpeg / file-first / purpose-first 均复现
Bearer / raw Authorization / x-api-key / api-key 均复现
```

当前判断：VectorEngine TTS `/minimax/v1/t2a_v2` 可用；文件上传 `/minimax/v1/files` 更像 VectorEngine 对 MiniMax File API 的代理解析问题。默认克隆走 MiniMax 官方 key 直连 `https://api.minimaxi.com/v1/files/upload`；若继续使用 VectorEngine 克隆，需要把上述响应和 request id 发给 VectorEngine 修代理。

## 4. voice_id 命名与复用

克隆时自定义 `voice_id`，规则：

```text
长度 8-256
必须以英文字母开头
只能包含字母、数字、-、_
不能以 - 或 _ 结尾
不能和已有 voice_id 重复
```

建议命名：

```text
voah_fangshai_qidian_female_20260605_v1
voah_beauty_seller_20260605_v1
```

复用方式很简单：后续 TTS 请求直接写入 `voice_setting.voice_id`。

```json
{
  "model": "speech-2.8-hd",
  "text": "最终口播文案",
  "voice_setting": {
    "voice_id": "voah_beauty_seller_20260605_v1",
    "speed": 1,
    "vol": 1,
    "pitch": 0
  }
}
```

注意：克隆生成的 `voice_id` 初始可能是未激活状态。官方 FAQ 说明，生成后 7 天内要通过 T2A v2 或 T2A Large 真正合成一次音频，才能长期保存；`voice_clone` 里的 preview 不算激活。

## 5. BGM 风险

BGM 会影响克隆质量。

常见问题：

```text
音色发糊
人声像隔着音乐/压缩器
尾音带音乐残影
后续 TTS 底噪变重
声纹不稳定，忽甜忽尖或忽近忽远
```

MiniMax 克隆接口有：

```json
{
  "need_noise_reduction": true,
  "need_volume_normalization": true
}
```

但这更像降噪/归一化，不应把它当成强力去 BGM。最佳方案仍然是换干净语料。

## 6. 语料建议

优先级从高到低：

```text
1. 单人干声录音，20-60 秒，安静环境，无 BGM
2. 原视频里截出 10-30 秒连续单人口播，BGM 很轻
3. 对原视频做人声分离后取 vocals，再人工听检
4. 直接拿带明显 BGM 的成片音轨
```

推荐录制内容：

```text
普通自然口播，不要太表演
包含正常语速、轻微情绪、常见带货词
不要唱歌，不要大喊，不要多人插话
不要混剪多段差异很大的声线
```

建议录一段 30-60 秒：

```text
今天这盒防晒气垫，我觉得最适合夏天通勤和出门补妆。它不是那种厚重底妆感，轻轻一拍，肤色会更匀，泛红暗沉也能压下去一点。关键是它一盒能兼顾底妆、定妆、补妆和防晒，包里少带几样东西，出门会轻松很多。
```

## 7. 当前微信视频素材质检

路径：

```text
/Users/noah/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/cutebug0523_ef01/msg/video/2026-06/0c7d38900ec5b70f7272f987de973544.mp4
```

探测结果：

```text
视频：320x568, 30fps, 50.8s
音频：aac, 44100 Hz, stereo, 50.69s
```

已提取产物：

```text
/Users/noah/混剪/cache/voah_tts/voice_clone_sources/20260605_wechat_0c7d3890/source_audio_original.m4a
/Users/noah/混剪/cache/voah_tts/voice_clone_sources/20260605_wechat_0c7d3890/source_audio_clone_32k_mono.mp3
/Users/noah/混剪/cache/voah_tts/voice_clone_sources/20260605_wechat_0c7d3890/source_audio_clone_32k_mono.wav
/Users/noah/混剪/cache/voah_tts/voice_clone_sources/20260605_wechat_0c7d3890/waveform.png
/Users/noah/混剪/cache/voah_tts/voice_clone_sources/20260605_wechat_0c7d3890/spectrogram.png
```

该素材时长和大小符合官方主克隆音频要求，但频谱显示全程较满，若实际听感有明显 BGM，不建议直接用作最终克隆源。可作为接口测试源，但不作为最终声纹源。

## 8. 官方 MiniMax 实测结果

2026-06-05 官方 MiniMax 直连已验证成功：

```text
provider: minimax-official
base_url: https://api.minimaxi.com
upload_endpoint: POST /v1/files/upload
clone_endpoint: POST /v1/voice_clone
activation_tts_endpoint: POST /v1/t2a_v2
source_audio: /Users/noah/混剪/cache/voah_tts/voice_clone_sources/20260605_wechat_a7cb2bf8/source_audio_clone_32k_mono.mp3
source_audio_qa: mp3, 32kHz, mono, 34.065s, 546766 bytes
file_id: 405863759241456
voice_id: voah_a7cb2bf8_20260605_v1
activated: true
```

产物：

```text
run_dir:
/Users/noah/混剪/cache/voah_tts/voice_clone_sources/20260605_wechat_a7cb2bf8/minimax_official_clone_20260605_154055

clone_demo_audio.mp3    # voice_clone preview，约 9.94s
clone_demo_audio.wav
clone_activation_audio.mp3    # T2A v2 激活样音，约 6.52s
clone_activation_audio.wav
```

manifest：

```text
/Users/noah/混剪/cache/voah_tts/voice_clone_sources/20260605_wechat_a7cb2bf8/voice_clone_manifest.json
```

跨通道复用测试：

```text
test: 用 VectorEngine /minimax/v1/t2a_v2 调用官方 MiniMax 克隆 voice_id
voice_id: voah_a7cb2bf8_20260605_v1
result: failed
base_resp.status_code: 2042
base_resp.status_msg: you don't have access to this voice_id
run_dir: /Users/noah/混剪/cache/voah_tts/vectorengine_official_clone_voiceid_test/20260605_155451
```

结论：官方 MiniMax 克隆音色不能拿到 VectorEngine 代理 key 下复用；克隆音色按账号/通道隔离。后续使用该克隆音色时默认走官方 MiniMax。

## 9. Voah 落盘合同

声音克隆成功后写：

```text
voice_clone_manifest.json
```

建议字段：

```json
{
  "stage": "voice_clone",
  "provider": "minimax-official",
  "source_audio": "/absolute/path/source_audio_clone_32k_mono.mp3",
  "source_audio_qa": {
    "duration_s": 30.0,
    "format": "mp3",
    "bgm_risk": "low|medium|high",
    "single_speaker": true
  },
  "remote": {
    "source_file_id": 123456789,
    "prompt_file_id": 987654321,
    "voice_id": "voah_a7cb2bf8_20260605_v1",
    "activated": true
  },
  "outputs": {
    "preview_audio": "/absolute/path/clone_preview.mp3",
    "activation_audio": "/absolute/path/clone_activation.mp3"
  },
  "next_consumers": ["voah-tts"]
}
```

`voice_id` 要同步进任务级 TTS 配置，但不要写 API key。
