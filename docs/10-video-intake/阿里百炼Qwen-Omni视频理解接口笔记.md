# 阿里百炼 Qwen-Omni 视频理解接口笔记

## 1. 文档来源

- 非实时 Qwen-Omni：https://help.aliyun.com/zh/model-studio/qwen-omni
- 实时 Qwen-Omni-Realtime：https://help.aliyun.com/zh/model-studio/realtime
- 全模态模型总览：https://help.aliyun.com/zh/model-studio/omni/

当前日期：2026-05-30。

后续实现前仍需以官方文档为准重新核对一次模型名、限制和计费。

## 2. 非实时视频理解

### 2.1 定位

非实时 Qwen-Omni 是 HTTP 调用，不是异步任务队列。

它通过 OpenAI 兼容接口接收文本、图片、音频、视频输入，并返回文本或音频输出。

对混剪工作台来说，它适合作为第一版视频理解主链路。

### 2.2 推荐模型

第一版优先：

```text
qwen3.5-omni-plus
```

理由：

- 支持长视频分析。
- 文档描述适用于长视频分析、会议纪要、字幕生成、内容审核、音视频交互等场景。
- 支持文本与图片、音频、视频的多模态组合输入。

成本敏感或短视频验证可试：

```text
qwen3-omni-flash
```

注意：

- `qwen3-omni-flash` 单次音视频限制为 150 秒。
- 文档提示使用 Qwen3-Omni-Flash 时需在非思考模式下运行。

### 2.3 地域和 Base URL

北京地域：

```text
https://dashscope.aliyuncs.com/compatible-mode/v1
```

新加坡地域：

```text
https://dashscope-intl.aliyuncs.com/compatible-mode/v1
```

北京和新加坡的 API Key 不同。

环境变量：

```text
DASHSCOPE_API_KEY
```

### 2.4 输入方式

视频文件形式：

```json
{
  "type": "video_url",
  "video_url": {
    "url": "https://example.com/source.mp4"
  }
}
```

图片列表形式：

```json
{
  "type": "video",
  "video": [
    "https://example.com/frame001.jpg",
    "https://example.com/frame002.jpg"
  ]
}
```

第一版优先使用视频文件形式，因为它可以理解视频中的音频信息。

### 2.4.1 公网 URL 可访问性判断

如果不走 Base64，`video_url.url` 应提供一个模型服务端可以直接访问的公网文件 URL。

结合 Qwen-Omni 文档和百炼多模态文件传入要求，第一版按以下规则处理：

- URL 使用 `https://` 最稳，`http://` 可作为临时测试。
- URL 必须能从公网直接下载，不能是内网地址、本机 `localhost`、局域网 IP 或需要登录态的地址。
- “纯 IP + 端口 + 文件路径”理论上可以，只要它是公网 IP，且 HTTP 响应像普通静态文件服务。
- 响应头应包含正确的 `Content-Type`，例如 `video/mp4`。
- 响应头应包含 `Content-Length`，不建议使用无法明确文件大小的流式动态响应。
- 建议 URL 带短时效 token 或签名，不要长期裸奔公开素材。
- 如果是云服务器自建文件服务，需要确认安全组、防火墙、Nginx/Caddy 静态文件配置都允许百炼侧访问。

因此，“租个服务器当网盘”是可行方向，但更稳的第一选择是：

```text
本地原片
  -> 生成压缩代理或直接上传原片
  -> 上传到 OSS / S3 兼容对象存储
  -> 生成短时效预签名 HTTPS URL
  -> 传给 Qwen-Omni
```

自建 VPS 静态文件服务也能做，但需要自己处理：

- HTTPS 证书。
- MIME 类型。
- Range 请求兼容性。
- 防盗链或临时授权。
- 文件过期清理。
- 日志和访问失败排查。

如果只是早期验证，公网 IP 的临时 HTTP 静态服务可以试；如果要稳定批量跑，优先 OSS/对象存储。

### 2.5 关键限制

Qwen3.5-Omni 系列：

- 公网 URL 视频最大 2GB。
- 视频最长 1 小时。
- 公网 URL 最多可传入 512 个视频。
- Base64 最多 250 个视频，但编码后 Base64 字符串必须小于 10MB。

Qwen3-Omni-Flash：

- 公网 URL 视频最大 256MB。
- 音视频最长 150 秒。
- 仅支持输入一个视频文件。

支持格式：

```text
MP4、AVI、MKV、MOV、FLV、WMV 等
```

计费注意：

- 视频文件中的视觉信息与音频信息会分开计费。
- 具体价格需要看百炼控制台计费页。

## 3. 最小调用形态

Python：

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.getenv("DASHSCOPE_API_KEY"),
    base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
)

completion = client.chat.completions.create(
    model="qwen3.5-omni-plus",
    messages=[
        {
            "role": "user",
            "content": [
                {
                    "type": "video_url",
                    "video_url": {
                        "url": "https://example.com/source.mp4"
                    },
                },
                {
                    "type": "text",
                    "text": "请按时间戳描述这个视频的内容。"
                },
            ],
        },
    ],
    modalities=["text"],
    stream=True,
    stream_options={"include_usage": True},
)

for chunk in completion:
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="")
    else:
        print(chunk.usage)
```

说明：

- 文档示例里 `stream` 必须为 `true`。
- 入库阶段不需要模型输出音频，所以 `modalities` 用 `["text"]`。
- 如果以后要同时测试语音输出，再使用 `modalities=["text", "audio"]` 和 `audio={"voice": "...", "format": "wav"}`。

## 4. 混剪入库 Prompt

第一版建议用中文结构化 prompt，直接要求输出 Markdown。

```text
请对这个视频做适合“短视频混剪素材库”的结构化理解。

你必须按时间戳输出，不要只写总体摘要。

请输出以下部分：

## 全局摘要
用 3-5 句话概括视频的主要内容、情绪、人物、场景和可用于混剪的价值。

## 时间线故事
按时间顺序拆分语义片段。每个片段必须包含：
- 起止时间，格式为 mm:ss.xxx - mm:ss.xxx
- 画面描述
- 发生的动作或事件
- 情绪/氛围
- 适合的混剪用途标签

## 可见文字
列出画面中出现的文字。每条包含：
- 起止时间
- 原文
- 位置或外观
如果没有文字，明确写“无可见文字”。

## 说话人与转写
列出语音内容。每条包含：
- 起止时间
- 说话人
- 原文
- 语气、情绪、语速
如果没有人声，明确写“无人声”。

## 可检索标签
输出 10-30 个标签，覆盖人物、场景、动作、情绪、物体、主题、拍摄类型。

## 混剪建议
列出这个素材适合用于哪些短视频段落，例如开头钩子、冲突升级、情绪铺垫、证据展示、反转、结尾留白。
```

后续如果 Markdown normalize 不稳定，再改成 JSON 输出。但第一版用 Markdown 更容易人工检查模型理解质量。

## 5. 内部归一化目标

模型原始输出保存为：

```text
cache/aliyun_qwen_omni/{asset_id}/raw_response.md
cache/aliyun_qwen_omni/{asset_id}/request.json
cache/aliyun_qwen_omni/{asset_id}/usage.json
```

归一化后生成：

```json
{
  "asset_id": "asset_001",
  "provider": "aliyun_qwen_omni",
  "model": "qwen3.5-omni-plus",
  "clips": [
    {
      "clip_id": "asset_001_c0001",
      "start": 0.0,
      "end": 5.2,
      "summary": "片段摘要",
      "visual_description": "画面描述",
      "event": "动作或事件",
      "mood": "情绪/氛围",
      "transcript": "",
      "ocr_text": "",
      "tags": ["标签1", "标签2"],
      "remix_uses": ["开头钩子", "冲突升级"]
    }
  ]
}
```

## 6. 实时接口判断

实时 Qwen-Omni-Realtime 使用 WebSocket 或 WebRTC。

北京地域 WebSocket：

```text
wss://dashscope.aliyuncs.com/api-ws/v1/realtime
```

模型示例：

```text
qwen3.5-omni-plus-realtime
```

它能理解流式音频和图像输入，例如从视频流中实时抽取的连续图像帧。

但它不是第一版素材入库主链路：

- WebSocket 通过 `input_audio_buffer.append` 添加音频。
- WebSocket 通过 `input_image_buffer.append` 添加图片。
- WebRTC 通过音频轨道和视频轨道传输。
- 文档建议视频通话场景可约 1 张/秒抽帧发送图像。

因此实时接口更适合后续：

- 交互式素材浏览。
- 对某个片段追问。
- 人工剪辑时边看边问。
- 对候选时间线做局部验证。

## 7. 第一版实现建议

先做一个脚本：

```text
scripts/aliyun_qwen_omni_analyze.py
```

参数：

```text
--video-url https://example.com/source.mp4
--asset-id asset_001
--model qwen3.5-omni-plus
--output-dir cache/aliyun_qwen_omni/asset_001
```

输出：

```text
request.json
raw_response.md
usage.json
```

暂时不处理本地文件上传。先用公网 URL 验证模型质量。

如果模型理解质量可用，再补：

- 本地文件上传 OSS/生成临时 URL。
- 长视频分段。
- Markdown 到 `Clip[]` 的 normalize。
- 缓存和重复处理判断。
