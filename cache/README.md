# Cache 产物索引

`cache/` 是本地运行产物区，包含素材入库、单次任务、TTS 实验、调研验证和第三方项目缓存。这里的大文件和模型产物通常不进 git，但必须能被文档和 manifest 追溯。

## 主线目录

### 常驻素材库

```text
voah_video_intake/{product_slug}/{timestamp}_{run_label}/
```

用于保存素材入库产物：

```text
assets.json
story_units.json
shots.json
physical_shots.json
trimmed_physical/
embedding_results.json
run_manifest.json
```

当前防晒气垫可用入库：

```text
voah_video_intake/fangshai-qidian/20260603_225800_merged5_scene_candidates_v1/
```

### 单次混剪任务

```text
voah_tasks/{product_slug}/{timestamp}_{task_slug}/
```

用于保存一次成片任务的全链路产物。

当前主线回归：

```text
voah_tasks/fangshai-qidian/20260605_202301_mainline_tts_semantic_v1/
```

关键文件：

```text
RUN_PROCESS.md
full_pipeline_manifest.json
voice_script.json
audio_sections.json
candidate_sections.json
timeline_selection.json
timeline_fill.json
caption_plan.json
preview_no_subtitles.mp4
hyperframes_subtitle_burn/final_subtitled.mp4
```

## 实验与历史目录

```text
voah_tts/               TTS 接口、音色、声音克隆和试听实验
voah_clean_cuts/        单素材干净切分实验
voah_manual_cuts/       人工/半人工切分验证
voah_evals/             评估产物
remix_eval/             早期 rough v1 混剪实验
vectorization_eval/     早期视频向量化实验
aliyun_qwen_omni/       阿里 Omni 早期调用探测
sentrysearch_eval/      SentrySearch 调研验证
vendor/                 第三方项目缓存
probe/                  临时探测截图/帧
proxy/                  临时代理视频
```

## 维护规则

- 正式链路产物优先放 `voah_video_intake/` 或 `voah_tasks/`。
- 新实验目录要有能解释目的的 run label。
- 单次任务目录里至少保留一个 manifest 或过程记录。
- 不把 API key 写入任何 cache manifest。
- 清理前先确认是否被 README、docs 或 manifest 引用。
- 历史实验可以保留，但不要把 legacy 路径当主线范式。
