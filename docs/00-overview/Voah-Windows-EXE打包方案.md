# Voah Windows EXE 打包方案

> 当前状态：只作为后续实现方案，不在系统未稳定前落 electron-builder、HyperFrames npm 依赖或 GitHub Actions 实现。

## 1. 目标

在 GitHub Actions 上构建 Windows 安装包或便携包，让员工机器拿到 `.exe` 后可以直接运行 Voah Studio，并尽量减少本机环境配置。

目标包应包含：

- Electron + React 桌面端。
- Voah CLI。
- repo 内 `scripts/` worker。
- 入库阶段仍依赖的 `voah-video-intake` skill 脚本。
- 召回阶段仍依赖的 `voah-shot-retrieval` skill 脚本。
- ffmpeg / ffprobe Windows 静态二进制。
- HyperFrames CLI 及其 Node 依赖。
- 默认字幕字体。

不包含：

- API key。
- 原片、产品素材、cache 产物。
- 本地模型环境。
- GPT-SoVITS。
- 旧桌面壳。

## 2. 当前主线状态

当前 GitHub `main` 已包含：

- Windows / Linux HyperFrames 默认硬件策略：`workers=auto`、启用 GPU。
- macOS 默认保守策略：`workers=1`、关闭 browser GPU。
- 桌面端批量任务和样片任务透传 `720p / 1080p` 分辨率参数。
- CLI-first 生产内核，桌面端只负责提交参数、展示任务、调用 CLI。

也就是说，后续打包不应该重新设计生产流程，只需要把当前 CLI runtime 变成可分发 runtime。

## 3. 推荐包结构

Electron 安装目录只放只读运行时：

```text
Voah Studio/
  Voah Studio.exe
  resources/
    app.asar
    voah-runtime/
      cli/
      scripts/
      skills/
        voah-video-intake/
        voah-shot-retrieval/
      bin/
        win32-x64/
          ffmpeg.exe
          ffprobe.exe
      fonts/
        SmileySans-Oblique.otf
        ZCOOLKuaiLe-Regular.ttf
        ZCOOLQingKeHuangYou-Regular.ttf
      node/
        hyperframes/
```

用户工作区放到可写目录：

```text
%USERPROFILE%\.voah\
  config.json
  secrets.env
  studio_settings.json
  fonts/
  workspace/
    data/
    cache/
```

原因：

- Windows `Program Files` 默认不可写，不能把 cache、产品库、任务产物写到安装目录。
- 运行时可随安装包替换，用户数据不受升级影响。
- API key 仍只写本机私有配置，不进入包和产物。

## 4. 运行时解析原则

桌面端启动后需要区分两种根：

```text
runtime_root   = 应用随包只读资源
workspace_root = 用户可写数据目录
```

开发态：

```text
runtime_root   = repo root
workspace_root = repo root
```

打包态：

```text
runtime_root   = process.resourcesPath/voah-runtime
workspace_root = %USERPROFILE%/.voah/workspace
```

CLI 调用必须显式传：

```bash
voah task run <task_dir> --workspace <workspace_root>
```

worker 脚本路径必须从 `runtime_root/scripts` 解析，不能再假设脚本就在 `workspace_root/scripts`。

## 5. 工具链路径

### ffmpeg / ffprobe

优先级：

1. `VOAH_FFMPEG` / `VOAH_FFPROBE`。
2. `runtime_root/bin/win32-x64/ffmpeg.exe`。
3. 系统 PATH。

Python worker 里大量通过 `ffmpeg` / `ffprobe` 命令名调用，因此 CLI 启动 worker 时应把随包 `bin/win32-x64` prepend 到 `PATH`。

### HyperFrames

优先级：

1. `VOAH_HYPERFRAMES`。
2. `runtime_root/node/node_modules/.bin/hyperframes.cmd`。
3. 桌面端 `node_modules/.bin/hyperframes.cmd`。
4. 系统 PATH。

打包后不建议依赖 `npx --yes hyperframes`，因为员工机器离线、代理或 npm 源问题都会让渲染阶段变成不稳定点。

### Python

短期可以保留外部 Python 前置要求：

```text
VOAH_PYTHON > python > py -3
```

中期若要真正“一键运行”，再把 Python runtime 单独纳入包：

```text
runtime_root/python/
  python.exe
  Lib/site-packages/
```

必须包含的 Python 依赖以仓库根目录 `requirements.txt` 为准；变更 Python worker 或仍被调用的 skill scripts 后，应同步更新该文件。

## 6. GitHub Actions 方案

后续实现时新增 Windows workflow：

```text
.github/workflows/build-windows.yml
```

流程：

1. `checkout`。
2. `setup-node@v4`，Node 20。
3. 安装桌面端依赖。
4. 下载 Windows 静态 ffmpeg/ffprobe 到 runtime 目录。
5. 复制 `cli/`、`scripts/`、需要的 skill scripts、默认字体到 runtime 目录。
6. 安装或复制 HyperFrames runtime 依赖。
7. `npm run build`。
8. `electron-builder --win nsis portable`。
9. 上传 artifacts：
   - `Voah Studio Setup *.exe`
   - `Voah Studio Portable *.exe`
   - checksum。

不要在 workflow、package 配置或文档中写入任何 API key。

## 7. 实现前置检查

正式开工前先解决这些边界：

- `desktop/voah-studio/electron/voahService.js` 不应静态 import `../../../cli/...`，打包后应从 runtime 动态加载，或只通过 CLI 子进程通信。
- CLI 不应把 `workspace/scripts` 当作唯一 worker 位置，需要支持 `VOAH_RUNTIME_ROOT` 或 `VOAH_SCRIPTS_DIR`。
- `voah_intake_desktop_wrapper.py` 目前会调用 `voah-video-intake` skill 脚本，打包时必须把该 skill 的 `scripts/` 纳入 runtime。
- `voah_retrieve_fill_from_audio_sections.py` 仍引用 `voah-shot-retrieval/scripts/search.py`，打包时也必须纳入 runtime 或搬进 repo。
- HyperFrames 不能依赖 `npx` 现场下载。
- 字体应随包复制到 runtime，再在用户目录生成可写副本用于预览和渲染。

## 8. 验收标准

Windows 包可用的最低验收：

```text
Voah Studio.exe 能启动
设置页能保存 key
doctor 能看到 ffmpeg / ffprobe / HyperFrames
素材入库能跑到 shot_index.json
720p 批量任务能跑出成片
1080p 批量任务能跑出成片
字幕默认字体可用
失败任务可在任务中心继续
```

如果 Python runtime 还未随包，则 doctor 必须明确显示 Python 未内置，并给出本机 Python 配置状态；不能让任务执行到一半才报找不到 Python。

## 9. 推荐节奏

当前系统仍在稳定生产管线，因此暂不落打包实现。

建议等下面几项稳定后再开 issue：

1. CLI 和桌面端的每个入口一一对应。
2. 入库、批量、字幕、分辨率和任务中心连续跑几轮无结构性问题。
3. skill 依赖脚本完成 repo 化，或明确随包策略。
4. 本地 Python 依赖清单固定。
5. GitHub Actions 只负责构建，不负责业务逻辑修补。
