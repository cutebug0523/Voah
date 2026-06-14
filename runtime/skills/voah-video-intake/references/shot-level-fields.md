# Shot-Level Fields Reference

Omni 输出的每个 highlight 必须包含以下 shot 级字段。这些字段让每个 shot 可以独立被检索和匹配，不再依赖 Asset/full-video 级汇总。

## Required Fields Per Highlight

```json
{
  "highlights": [
    {
      "start": 0.0,
      "end": 2.0,
      "label": "一句话描述该片段的核心内容",
      "visual_summary": "该 shot 时间范围内的画面描述（2-3 句）",
      "source_meaning": "该 shot 传达的核心信息和内容本质",
      "source_asr": "该 shot 时间范围内的口播/旁白文字。如无音频轨则为空字符串",
      "source_ocr": "该 shot 时间范围内的屏幕文字/字幕。如无则为空数组",
      "hard_subtitle_risk": "none|low|medium|high — 硬编码字幕是否干扰二次剪辑",
      "voiceover_fit": "excellent|good|fair|poor — 该片段是否适合叠加新配音",
      "usable_start": 0.0,
      "usable_end": 2.0,
      "can_standalone": true
    }
  ]
}
```

## Field Descriptions

| 字段 | 类型 | 说明 |
|------|------|------|
| `start` / `end` | float | 在源视频中的时间范围（秒），精确到 0.1 |
| `label` | string | 一句话概括，用于快速浏览和标签 |
| `visual_summary` | string | 画面内容详细描述，用于向量检索和文案匹配 |
| `source_meaning` | string | 该片段的核心信息本质，用于文案匹配 |
| `source_asr` | string | 该片段内的口播文字。可与 full-video ASR 重叠但应尽量精确定位 |
| `source_ocr` | string[] | 该片段内的屏幕文字。逐条列出 |
| `hard_subtitle_risk` | enum | 硬字幕风险等级。影响该 shot 是否可用于叠加新字幕 |
| `voiceover_fit` | enum | 叠加配音适配度。poor 表示原片音频/口播不可剥离 |
| `usable_start` / `usable_end` | float | 最优可用区间（秒）。可窄于 start/end（裁掉过渡帧） |
| `can_standalone` | bool | 该片段是否可独立成段（不需要前后文就能理解） |

## Omni Prompt Template

```
你是一个视频素材分析专家。请观看下面的视频，从混剪素材的角度进行结构化分析。

产品背景：{product_context}

请严格按以下 JSON 格式输出：

{
  "visual_summary": "整条视频的画面描述",
  "source_ocr": ["逐条屏幕文字"],
  "source_asr": "完整口播内容",
  "source_meaning": "整条视频的核心信息",
  "selling_points": ["卖点列表"],
  "visual_actions": ["关键画面动作"],
  "shot_type": ["镜头类型"],
  "timeline_roles": ["适合的视频环节"],
  "product_evidence": "产品展示方式",
  "hard_subtitle_risk": "none|low|medium|high",
  "voiceover_fit": "excellent|good|fair|poor",
  "usable_start": 0.0,
  "usable_end": 0.0,
  "highlights": [
    {
      "start": 0.0,
      "end": 0.0,
      "label": "高光时刻描述",
      "visual_summary": "该 shot 的画面描述",
      "source_meaning": "该 shot 的核心信息",
      "source_asr": "该 shot 内的口播（如适用）",
      "source_ocr": ["该 shot 内的屏幕文字"],
      "hard_subtitle_risk": "none|low|medium|high",
      "voiceover_fit": "excellent|good|fair|poor",
      "usable_start": 0.0,
      "usable_end": 0.0,
      "can_standalone": true
    }
  ]
}

注意：
- highlights 列出 3-6 个最精彩/最有剪辑价值的片段
- 每个 highlight 必须包含上述全部字段（source_asr/source_ocr 可为空）
- 所有时间以秒为单位，精确到 0.1 秒
- usable_start/usable_end 为最优可用区间，可窄于 start/end
- can_standalone=true 表示该片段不需要前后文就能独立理解
```
