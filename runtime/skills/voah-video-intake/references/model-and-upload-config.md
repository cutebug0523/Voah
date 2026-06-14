# Model And Upload Config

Use this reference when `voah-video-intake` needs DashScope/Qwen model calls, temporary OSS upload, or local credential setup.

Last checked against Alibaba Cloud official docs on 2026-06-02.

## 1. Local Secrets

Preferred secret file:

```text
~/.voah/video_intake/.env
```

Required key:

```text
DASHSCOPE_API_KEY=...
```

Load order:

```text
1. Existing process env: DASHSCOPE_API_KEY
2. ~/.voah/video_intake/.env
3. Ask user for key and save locally
```

Never write keys to:

- repo runtime skill files
- workspace docs
- `cache/voah_video_intake/`
- manifests
- command transcripts

Use `scripts/save_dashscope_key.py` to save the key with file mode `0600`.

## 2. Model Defaults

### Video Understanding

Default:

```json
{
  "provider": "dashscope",
  "model": "qwen3.5-omni-plus",
  "api_style": "HTTP / OpenAI-compatible",
  "purpose": "batch video understanding, OCR/ASR/visual summary/source_meaning extraction",
  "inputs": ["text", "audio", "image", "video"],
  "output_preference": "JSON text",
  "temperature": 0.1,
  "top_p": 0.8
}
```

Use `qwen3.5-omni-plus` for batch intake. Do not use realtime unless the task is interactive/live. Realtime variant:

```json
{
  "model": "qwen3.5-omni-plus-realtime",
  "api_style": "WebSocket",
  "purpose": "live interaction, streaming audio/video conversation"
}
```

Prompt the model to return strict JSON with:

- `visual_summary`
- `source_ocr`
- `source_asr`
- `source_meaning`
- `selling_points`
- `visual_actions`
- `shot_type`
- `timeline_roles`
- `product_evidence`
- `hard_subtitle_risk`
- `voiceover_fit`
- `usable_start`
- `usable_end`

### Vectorization

Default:

```json
{
  "provider": "dashscope",
  "model": "qwen3-vl-embedding",
  "api_style": "DashScope MultiModalEmbedding",
  "purpose": "multi-lane text/image/video embeddings for retrieval",
  "dimension": 2560,
  "enable_fusion": false
}
```

Officially supported dimensions for `qwen3-vl-embedding`:

```text
2560, 2048, 1536, 1024, 768, 512, 256
```

Use separate embeddings by default:

- native video chunk
- visual summary
- source meaning
- ASR
- OCR
- tags

Use `enable_fusion=true` only for an explicit fused lane such as text+video combined retrieval. Keep separate lanes for explainability and rerank.

Optional future candidate:

```json
{
  "model": "tongyi-embedding-vision-plus-2026-03-06",
  "dimension": 1152,
  "res_level": 1,
  "max_video_frames": 64,
  "status": "candidate, not default"
}
```

## 3. Temporary OSS Upload

Use temporary OSS when a model call requires a URL for a local file.

Preferred command:

```bash
dashscope oss upload -f /absolute/path/to/file.mp4 -m qwen3-vl-embedding
```

Examples:

```bash
dashscope oss upload -f /absolute/path/to/window.mp4 -m qwen3.5-omni-plus
dashscope oss upload -f /absolute/path/to/shot.mp4 -m qwen3-vl-embedding
```

The command uses `DASHSCOPE_API_KEY` from the environment. Avoid passing `--api_key` on the command line because it may enter shell history.

Important constraints:

- Returned URLs have `oss://` prefix.
- Temporary URL validity is about 48 hours.
- Upload model and call model must match exactly.
- API key/account used for upload and model call must belong to the same Alibaba Cloud main account.
- For HTTP calls with `oss://` URLs, include header `X-DashScope-OssResourceResolve: enable`.
- DashScope SDK can pass `oss://` strings directly and handles the required header.
- Temporary OSS URLs are not durable assets; record them only in `upload_manifest.json` with expiry metadata.

Record upload metadata:

```json
{
  "local_path": "/absolute/path/to/window.mp4",
  "oss_url": "oss://dashscope-instant/...",
  "upload_model": "qwen3-vl-embedding",
  "expires_at_hint": "uploaded_at + 48h",
  "purpose": "embedding_video_chunk"
}
```

## 4. Model Config Snapshot

Each ingest run should write non-secret model config to:

```text
model_config_snapshot.json
```

Example:

```json
{
  "understanding": {
    "provider": "dashscope",
    "model": "qwen3.5-omni-plus",
    "temperature": 0.1,
    "top_p": 0.8
  },
  "embedding": {
    "provider": "dashscope",
    "model": "qwen3-vl-embedding",
    "dimension": 2560,
    "enable_fusion": false
  },
  "temp_oss": {
    "enabled": true,
    "secret_source": "env:DASHSCOPE_API_KEY or ~/.voah/video_intake/.env"
  }
}
```

Never include the actual API key.

## 5. Primary Official References

- Qwen-Omni model family: https://help.aliyun.com/zh/model-studio/omni/
- Qwen-Omni API guide: https://help.aliyun.com/zh/model-studio/qwen-omni
- Multimodal Embedding API: https://help.aliyun.com/zh/model-studio/multimodal-embedding-api-reference
- Temporary OSS upload: https://help.aliyun.com/zh/model-studio/get-temporary-file-url

## 6. Video Embedding vs Text Embedding

v1.2.0 起，vectorization 严格区分两种嵌入方式：

| 通道 | 嵌入方式 | API 参数 | 数据源 |
|------|---------|---------|--------|
| video_chunk | `MultiModalEmbeddingItemBase` | `factor=1.0, video=trimmed_oss_url` | Step 5.5 裁切的物理片段 |
| visual_summary | `MultiModalEmbeddingItemText` | `text=...` | Omni shot 级 visual_summary |
| source_meaning | `MultiModalEmbeddingItemText` | `text=...` | Omni shot 级 source_meaning |
| asr | `MultiModalEmbeddingItemText` | `text=...` | Omni shot 级 source_asr |
| ocr | `MultiModalEmbeddingItemText` | `text=...` | Omni shot 级 source_ocr |
| tags | `MultiModalEmbeddingItemText` | `text=...` | shot_type_hint + label + selling_points |

**严格禁止**：video_chunk 通道使用 `MultiModalEmbeddingItemText`。必须对 Step 5.5 裁切的物理片段做原生 video embedding。
**注意**：不要对 OSS URL 文本做 embedding——把 URL 当作文本嵌入无意义。当前本机 DashScope SDK 没有 `MultiModalEmbeddingItemVideo` 类，正确写法是 `MultiModalEmbeddingItemBase(factor=1.0, video=trimmed_oss_url)` 或等价 dict `{"video": trimmed_oss_url, "factor": 1.0}`。

## 7. Shot-Level Omni Fields

v1.2.0 起，Omni prompt 要求每个 highlight 输出以下 shot 级字段：

- `visual_summary`：该 shot 的画面描述
- `source_meaning`：该 shot 的核心信息
- `source_asr`：该 shot 内的口播内容
- `source_ocr`：该 shot 内的屏幕文字
- `hard_subtitle_risk`：硬字幕风险（none/low/medium/high）
- `voiceover_fit`：叠加配音适配度（excellent/good/fair/poor）
- `usable_start` / `usable_end`：最优可用区间
- `can_standalone`：是否可独立成段

这些字段由 `scripts/normalize.py` 传播到 shots.json 的每个 shot 记录。
