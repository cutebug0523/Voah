# Voah 桌面应用架构

## 1. 当前决定

Voah 后续不把桌面版做成“调用 agent skill 的壳”。桌面版应该把已经验证的方法论固化为本地流程，让员工通过界面操作产品、素材、任务、预览和导出。

当前阶段只做架构设计，不急着落代码，不做界面设计。后续真正开工前，先 review 这几份细化文档：

```text
Voah桌面应用模块与产物流转设计.md
Voah桌面应用数据模型与任务状态机.md
Voah桌面应用服务边界与Worker合同.md
```

推荐 V1 技术栈：

```text
Electron + React
  -> Electron Main / Node 本地调度器
    -> Python Voah workers
    -> ffmpeg / ffprobe
    -> HyperFrames CLI
    -> SQLite
    -> 本地文件产物
```

不建议 V1 直接用 Rust/Tauri 或纯 Python 桌面主栈。

## 2. 为什么这样选

### Electron + Node 适合作主应用

- HyperFrames 本身是 HTML/Chromium/Node 生态，Electron 预览和渲染更顺手。
- ffmpeg、ffprobe、HyperFrames CLI 都适合由 Node `child_process` 调度。
- UI 可以实时展示任务进度、日志、预览、失败重试和人工复核。
- 打包时可以把前端、Node 主进程、Python worker、ffmpeg 和配置入口放在同一个应用里。

### Python 适合作 worker

- 现有 Voah 脚本已经围绕 Python、JSON、模型 API、音频/视频元数据处理沉淀。
- 不需要为了桌面化把算法层重写成 Node 或 Rust。
- 后续可把脚本逐步整理成稳定 CLI，再由 Electron 调度。

### Rust/Tauri 暂不作为 V1 主栈

- Tauri 体积小，但系统 WebView 差异会增加视频预览和 HyperFrames 兼容成本。
- Rust 对当前主要瓶颈帮助有限；当前核心是流程、素材、模型 API、字幕和验收。
- 后续如果出现明确性能瓶颈，可把局部能力做成 Rust worker。

### 纯 Python 桌面不作为主栈

- PyQt/Flet/NiceGUI 可以做界面，但复杂视频预览、任务状态、HyperFrames 集成和前端体验不如 Electron 顺。
- 员工使用场景需要更像一个产品，而不是调试台。

## 3. 应用边界

桌面版负责：

- 选择素材目录、创建产品、触发入库。
- 展示 story unit / physical shot / embedding 状态。
- 管理任务 brief、产品卖点、活动优惠和文案结构。
- 调用 TTS，试听和记录音色参数。
- 按音频主轴召回和填充素材。
- 展示无字幕预览、字幕预览和最终成片。
- 管理本地配置、API key、产物路径和导入导出。

桌面版不负责：

- 让员工理解 skill、cache 深层路径或命令行参数。
- 把聊天上下文当工程状态。
- 把 API key 写进 manifest 或文档。
- 每次任务重新理解全部素材。

## 4. 固定流程

```text
素材入库（常驻）
  -> 产品与素材库
  -> 任务 brief
  -> 文案工厂
  -> TTS / audio_sections
  -> 素材召回与时间线填充
  -> 字幕计划
  -> HyperFrames 字幕烧录
  -> QA
  -> 导出
```

入库是常驻层；单次任务从任务 brief、卖点和销售逻辑开始。

## 5. 并发边界

可以并发：

- 多视频 ffprobe。
- 多视频候选切点生成。
- 多个 story unit 上传和 embedding。
- 缩略图、抽帧、contact sheet、freezedetect。
- 不同 TTS 音色试听。

需要串行或按依赖执行：

- 文案第一步必须早于最终口播稿。
- TTS 必须早于 `audio_sections`。
- `audio_sections` 必须早于按语义召回和填充素材。
- `timeline_fill` 必须早于字幕烧录。
- 最终 QA 必须在渲染后执行。

## 6. 本地数据

建议 V1 使用 SQLite 管结构化索引，文件系统管大产物。

SQLite 适合记录：

- products
- intake_runs
- assets
- story_units
- physical_shots
- embedding_channels
- task_runs
- copy_versions
- tts_runs
- audio_sections
- timeline_items
- caption_runs
- render_outputs

文件系统继续承载：

```text
cache/voah_video_intake/{product_slug}/{timestamp}_{run_label}/
cache/voah_tasks/{product_slug}/{timestamp}_{task_slug}/
```

桌面应用可以把这些路径映射成可点击的产品、任务和产物，不要求员工自己找。

## 7. Worker 合同

每个本地 worker 都应该满足：

```json
{
  "schema_version": "1.0.0",
  "stage": "stage_name",
  "inputs": {},
  "outputs": {},
  "qa": {
    "status": "ok",
    "warnings": []
  },
  "next_consumers": []
}
```

这延续当前 Voah 工程化底座，方便桌面版做任务状态、失败重试、断点恢复和产物导入导出。

## 8. 从 skill 到桌面应用

当前 `voah-*` skills 的价值不是让员工调用，而是沉淀为：

1. 流程规格。
2. 输入输出 schema。
3. worker 验收标准。
4. QA 检查清单。

桌面版的按钮应该调用固定 worker，而不是让 agent 临场理解“下一步做什么”。

## 9. V1 模块

```text
首页
素材库
产品详情
入库任务详情
文案工厂
语音工厂
混剪任务
字幕与渲染
QA / 导出
设置
```

首页只展示工作台状态，不做营销页。

## 10. 打包建议

V1 可考虑：

```text
Electron Builder
React/Vite renderer
Node main process
Python worker venv 或 uv-managed runtime
bundled ffmpeg / ffprobe
HyperFrames CLI / Node dependencies
SQLite database under app data dir
configurable Voah workspace root
```

API key 存本机私有配置或系统 keychain，不写进仓库、文档、manifest。

## 11. 当前设计文档

模块与产物流转：

```text
docs/00-overview/Voah桌面应用模块与产物流转设计.md
```

数据模型与任务状态机：

```text
docs/00-overview/Voah桌面应用数据模型与任务状态机.md
```

服务边界与 worker 合同：

```text
docs/00-overview/Voah桌面应用服务边界与Worker合同.md
```
