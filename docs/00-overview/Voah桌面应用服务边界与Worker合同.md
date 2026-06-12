# Voah 桌面应用服务边界与 Worker 合同

## 1. 文档目的

这份文档只定义服务边界和 worker 合同，不写代码。

它回答：

- Electron Renderer 能做什么，不能做什么。
- Electron Main / Node 调度层负责什么。
- Python worker 怎么被调用。
- ffmpeg / ffprobe 和 HyperFrames 怎么接入。
- IPC 能力边界怎么设计。
- 日志、错误、API key、产物路径怎么处理。

## 2. 总体边界

```text
Renderer
  -> IPC
Main / Node
  -> Services
  -> JobQueue
  -> WorkerRunner
    -> Python scripts
    -> ffmpeg / ffprobe
    -> HyperFrames CLI
  -> SQLite
  -> File system artifacts
```

原则：

- Renderer 不直接读写任意文件。
- Renderer 不直接拿 API key。
- Renderer 不直接跑 Python / ffmpeg / HyperFrames。
- Main 只做调度、权限、状态、产物登记。
- Worker 只做单阶段能力，不做跨阶段决策。

## 3. Electron Renderer 边界

允许：

- 展示产品、任务、产物、日志、QA。
- 发起用户操作。
- 播放或预览已登记的本地媒体。
- 提交人工确认，例如文案确认、素材替换、字幕 preset 选择。

不允许：

- 直接访问任意本地路径。
- 直接读取 `.env` 或 keychain。
- 直接拼 shell 命令。
- 直接写 cache 产物。
- 直接调用模型 API。

Renderer 看到的路径应是 artifact id 或受控 file handle，而不是到处传裸路径。

## 4. Electron Main / Node 边界

职责：

```text
IPC handler
Service registry
SQLite connection
Artifact registry
Job queue
Worker process runner
File dialog
Safe path resolver
Settings and secret provider
```

不负责：

- 不写业务文案。
- 不直接做视频理解。
- 不把复杂媒体处理写死在 IPC handler。
- 不绕过 ArtifactService 直接把下游产物塞给 UI。

Main 里的每个 IPC handler 只应该做：

```text
校验请求
调用 service
返回结构化结果
```

## 5. Service 分层

建议服务：

```text
WorkspaceService
SettingsService
SecretService
DatabaseService
ArtifactService
JobQueueService
WorkerRunner
ProductService
IntakeService
CopyService
VoiceService
AssemblyService
RenderQaService
ImportExportService
```

### 5.1 WorkspaceService

职责：

- 当前 workspace root。
- cache root。
- 检查目录存在。
- 检查工具可用性。

输出：

```text
workspace_status
tool_status
```

### 5.2 SecretService

职责：

- 从系统 keychain 或本地私有配置读取 API key。
- 向 worker 注入环境变量。
- 不把 key 传给 Renderer。
- 不把 key 写进 manifest。

### 5.3 ArtifactService

职责：

- 统一登记产物。
- 校验产物存在。
- 计算 hash。
- 管依赖。
- 判断 stale。
- 给 Renderer 提供受控访问。

### 5.4 JobQueueService

职责：

- 串行/并发调度。
- 状态机。
- 取消和重试。
- 记录 stdout/stderr。
- 连接 WorkerRunner。

### 5.5 WorkerRunner

职责：

- 统一启动外部进程。
- 统一超时。
- 统一环境变量。
- 统一日志路径。
- 统一解析 worker manifest。

WorkerRunner 不理解业务流程，只理解 job。

## 6. IPC 能力分组

### 6.1 workspace

```text
workspace:getStatus
workspace:setRoot
workspace:scanExistingRuns
workspace:getToolStatus
```

### 6.2 settings

```text
settings:get
settings:update
settings:testProvider
```

注意：

`settings:get` 不返回真实 API key，只返回是否已配置。

### 6.3 products

```text
products:list
products:create
products:get
products:update
products:archive
products:setClaims
products:listClaims
```

### 6.4 intake

```text
intake:listRuns
intake:createRun
intake:startRun
intake:getRun
intake:getAssets
intake:getStoryUnits
intake:getPhysicalShots
intake:importRun
```

### 6.5 tasks

```text
tasks:list
tasks:create
tasks:get
tasks:archive
tasks:getArtifacts
tasks:getDependencyGraph
```

### 6.6 copy

```text
copy:createBrief
copy:updateBrief
copy:createVoiceScript
copy:updateVoiceScript
copy:listVersions
copy:markApproved
```

### 6.7 voice

```text
voice:listVoices
voice:testVoice
voice:createTtsRun
voice:getTtsRun
voice:getAudioSections
voice:markApproved
```

### 6.8 assembly

```text
assembly:createCandidates
assembly:updateSelectionOverrides
assembly:createTimeline
assembly:getTimeline
assembly:createPreview
```

### 6.9 render

```text
render:createCaptionPlan
render:updateCaptionPreset
render:createHyperFramesProject
render:startBurn
render:getOutput
```

### 6.10 qa

```text
qa:runChecks
qa:getReport
qa:listFrames
qa:markApproved
```

### 6.11 jobs

```text
jobs:list
jobs:get
jobs:cancel
jobs:retry
jobs:getLogs
```

### 6.12 artifacts

```text
artifacts:get
artifacts:listByRun
artifacts:getPreviewUrl
artifacts:revealInFinder
artifacts:exportBundle
```

## 7. Worker 类型

### 7.1 Python worker

用途：

- 模型 API。
- JSON 转换。
- TTS。
- 召回。
- caption plan。
- manifest。

调用形式：

```text
python scripts/xxx.py --input job_input.json --output job_result.json
```

后续现有脚本需要逐步包成这种统一入口。

### 7.2 ffmpeg worker

用途：

- ffprobe。
- 裁切。
- 拼接。
- 转码。
- 抽帧。
- freezedetect。

调用形式：

```text
ffmpeg / ffprobe command
```

Node 负责命令参数和日志记录。

### 7.3 HyperFrames worker

用途：

- lint。
- inspect。
- render。

调用形式：

```text
hyperframes lint
hyperframes inspect
hyperframes render
```

HyperFrames 工程目录必须登记为 artifact。

渲染参数由服务层统一控制，不从 Renderer 直接拼命令：

```json
{
  "production_config": {
    "render": {
      "hyperframes": {
        "workers": "auto",
        "browser_gpu": true
      }
    }
  }
}
```

默认策略必须保护当前 Mac 机器：macOS 默认 `workers=1` 且关闭 browser GPU；Windows / Linux 默认 `workers=auto` 且启用 GPU。实际执行值写入 HyperFrames manifest 的 `render.render_settings`，便于换生产机后排查。

### 7.4 Node internal worker

用途：

- 轻量文件扫描。
- hash。
- manifest import。
- SQLite migration。

不用于重型视频处理。

## 8. Worker 输入合同

统一 job input：

```json
{
  "schema_version": "1.0.0",
  "job_id": "uuid",
  "stage": "voice_tts",
  "workspace": {
    "root": "/Users/noah/混剪",
    "cache_root": "/Users/noah/混剪/cache"
  },
  "scope": {
    "type": "task_run",
    "id": "uuid",
    "dir": "/Users/noah/混剪/cache/voah_tasks/fangshai-qidian/..."
  },
  "inputs": {
    "voice_script": "/absolute/path/voice_script.json"
  },
  "options": {
    "provider": "minimax-official",
    "model": "speech-2.8-hd"
  },
  "env": {
    "required_keys": ["MINIMAX_API_KEY"]
  },
  "outputs": {
    "expected": {
      "tts_audio": "/absolute/path/tts_audio.json",
      "voice_wav": "/absolute/path/voice.wav"
    }
  }
}
```

`env.required_keys` 只写变量名，不写值。

## 9. Worker 输出合同

统一 job result：

```json
{
  "schema_version": "1.0.0",
  "job_id": "uuid",
  "stage": "voice_tts",
  "status": "succeeded",
  "created_at": "2026-06-05T20:55:59+0800",
  "inputs": {
    "voice_script": "/absolute/path/voice_script.json"
  },
  "outputs": {
    "tts_audio": "/absolute/path/tts_audio.json",
    "voice_wav": "/absolute/path/voice.wav",
    "audio_sections": "/absolute/path/audio_sections.json"
  },
  "artifacts": [
    {
      "kind": "tts_audio",
      "path": "/absolute/path/tts_audio.json",
      "schema_version": "1.0.0"
    }
  ],
  "qa": {
    "status": "ok",
    "warnings": []
  },
  "next_consumers": ["assembly:createTimeline", "render:createCaptionPlan"]
}
```

失败也要输出：

```json
{
  "schema_version": "1.0.0",
  "job_id": "uuid",
  "stage": "voice_tts",
  "status": "failed",
  "error": {
    "code": "provider_timeout",
    "message": "TTS provider timed out"
  },
  "outputs": {},
  "qa": {
    "status": "failed",
    "warnings": []
  }
}
```

## 10. 日志合同

每个 job 有独立日志目录：

```text
{run_dir}/logs/{job_id}/
  stdout.log
  stderr.log
  command.safe.json
  job_input.json
  job_result.json
```

`command.safe.json` 可以记录：

```text
command kind
argv with secrets redacted
cwd
started_at
finished_at
exit_code
```

不能记录：

```text
API key
完整 Authorization header
包含 key 的 URL
```

## 11. 错误分级

建议 error code 分组：

```text
config_missing
input_missing
schema_invalid
provider_error
provider_timeout
worker_exit_nonzero
artifact_missing
qa_failed
user_cancelled
unknown
```

错误必须能回答：

- 哪个阶段错。
- 哪个输入错。
- 日志在哪里。
- 能否重试。
- 是否已有上一个可用版本。

## 12. API key 策略

原则：

- Renderer 不见 key。
- SQLite 不存 key 明文。
- manifest 不存 key。
- 日志不存 key。
- worker 只通过环境变量拿 key。

建议：

```text
开发期：.env
桌面版：系统 keychain
导入导出：永不包含 key
```

## 13. 路径安全

所有用户选择路径要归一化：

```text
expand user
resolve absolute
check exists
check read/write permission
```

写入产物只允许在：

```text
workspace root
app data dir
用户显式选择的 export dir
```

不能让 Renderer 传任意 shell 字符串给 Main。

## 14. 现有脚本适配顺序

第一批适配：

```text
voah_generate_copy_with_m3.py
voah_run_oneshot_minimax_tts.py
voah_retrieve_fill_from_audio_sections.py
voah_build_caption_plan.py
voah_create_hyperframes_subtitle_project.py
HyperFrames CLI: lint / inspect / render
voah_omni_alignment_qa.py
voah_write_full_pipeline_manifest.py
```

`voah_generate_copy_with_m3.py` 的桌面端合同：

- 输入必须是 `task_brief.json`。
- 输出 `copy_brief.json` 和 `voice_script.json`。
- 文案阶段只定销售逻辑、连续口播、`required_meaning`、`required_visual`，不绑定具体 shot。
- `voice_script.full_voice_text` 是 TTS 与字幕文本真源。
- `required_visual` 只能写产品、粉扑、上脸、妆效、测试、陈列等可泛化画面需求；禁止把未证实的办公室、海边、车内等硬场景词作为正向召回目标。
- 如最终 Omni QA 给出 minor/major，允许生成一个结构化 copy calibration job：只改 `voice_script.json` 与 section 语义，让文案回到真实素材能支撑的范围；校准后必须从 TTS 重新往下跑。

`voah_retrieve_fill_from_audio_sections.py` 的桌面端合同：

- 输入必须是 TTS 后的 `audio_sections.json`、`voice.wav` 和素材库 `shot_index.json`。
- 读取 `shot_index.json` 后要校验 intake boundary contract：`physical_shots.json`、`trim_end_epsilon_s`、`clip_frames`、`clip_actual_duration_s`。
- `candidate_sections.json` 保留 story unit 候选和 child physical shot 元数据。
- `candidate_sections.json -> timeline_selection.json` 默认走 MiniMax M3 文本 planner：embedding 给候选区间，LLM 在候选池内选片、解释和控制复用多样性。
- MiniMax M3 planner 只读结构化文本候选，不默认多模态；产品过滤、可渲染性、child physical shot 连续取片、不 loop、时长补齐和半开裁切仍由代码硬校验。
- LLM 调用失败或输出无效时，必须回退 `rules_text_planner_v1` 并在 `timeline_selection.json.policy.llm_fallback_reason` 与 `llm_selection_plan.safe.json` 写明原因。
- `timeline_selection.json` 必须写明每段选中的 `child_physical_shot_id` 或 offset 依据。
- `timeline_fill.json` 必须记录实际渲染的 `source_clip_path`、`source_start_offset_s`、`source_end_offset_s`、`rendered_clip_path`。
- 默认不 loop；素材不足时走同语义拼接或 manual_review。
- worker 必须加载本地私有 env 并由 `SecretService` 注入 `MINIMAX_API_KEY`/`DASHSCOPE_API_KEY`；不得因为 key 未注入而静默退回规则 planner，除非产物里明确写 fallback reason。
- `parent_context_only` child 的父级命中只作为弱证据；如果 child 自身未验证硬画面词，必须标记 `requires_visual_review`，等待最终 Omni QA 复核。

`voah_omni_alignment_qa.py` 的桌面端合同：

- 输入必须是待验视频、`audio_sections.json`、`timeline_fill.json`。
- 每个 audio section 裁成小视频后调用 Qwen Omni 判断 `audio_caption_match`、`visual_match`、`overall`。
- DashScope OSS 上传结果必须使用完整 OSS URL 拼接逻辑；compatible API 调用必须带 `X-DashScope-OssResourceResolve: enable`。
- 输出 `qa_omni_alignment_*/omni_alignment_results.json` 和 `OMNI_ALIGNMENT_QA_REPORT.md`。
- 最终字幕版 Omni QA 是导出 gate：只有 `qa.status=ok` 才能自动标记可导出。
- 如果最终字幕版 Omni QA 通过，中间 `timeline_selection/timeline_fill` 的 child visual-review warning 可以归入 `resolved_warnings`，不能继续把任务标成失败。
- 如果出现 `major_review` 或 `fail`，桌面端优先提供两个重试入口：`rerank_material` 从召回重跑，`rewrite_copy` 从文案校准重跑。

原因：

- 它们覆盖任务层主线。
- 已经能从 `voice_script.json` 跑到最终 manifest。
- 比素材入库更适合先产品化。

第二批适配：

```text
aliyun_qwen_omni_analyze.py
入库切分 / embedding 相关脚本
```

原因：

- 入库复杂度更高。
- 需要先定义产品库和素材库导入。

## 15. 当前结论

实现时优先级：

```text
1. ArtifactService
2. JobQueueService
3. WorkerRunner
4. SQLite migration
5. 现有任务层脚本适配
6. 只读导入现有 run
7. 再做员工可见操作界面
```

不应该先做页面再反推服务。

桌面应用的稳定性来自：

```text
产物登记
状态机
日志
失败恢复
明确 worker 边界
```

不是来自一次性把 UI 画漂亮。
