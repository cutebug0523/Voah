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
voah_run_oneshot_minimax_tts.py
voah_retrieve_fill_from_audio_sections.py
voah_build_caption_plan.py
voah_create_hyperframes_subtitle_project.py
voah_write_full_pipeline_manifest.py
```

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
