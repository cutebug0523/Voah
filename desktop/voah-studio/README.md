# Voah Studio · 桌面生产工作台

面向员工的批量出片工具。前端只是壳，所有生产逻辑在 [voah CLI](../../cli/) 里。

## 设计原则

- **低心智**：日常走量路径越短越好，选产品+数量+时长就开跑。
- **可控不失控**：要质量时能预览文案、试听配音、单条复跑，但这些是"展开"出来的。
- **前端是壳**：只提交参数、调 voah 命令、读 manifest/日志、展示状态。不重写任何生产逻辑。

## 信息架构

```
左侧导航：队列 / 产品 / 成品库 / 设置
左下角常驻：今日产能（X/150 + 运行/待审/失败计数）
主工作区：随导航切换
```

## 与 CLI 的映射（M1）

| UI 操作 | CLI 命令 |
|---|---|
| 新建批量 → 直接开跑 | `voah batch run --product .. --count .. --target-duration ..` |
| 失败任务重试 | `voah task run {dir} --from {failed_stage}` |
| 队列/进度展示 | 读 `cache/voah_batches/.../batch_manifest.json` + 各 `task_manifest.json` |
| 打开任务/批次目录 | shell.showItemInFolder |

后续里程碑（M2/M3）会接入 `voah copy/tts run`（精修打样）、`voah tts preview`（试听）、`voah qa`（成品库复核）等。

## 开发

```bash
npm install
npm run dev
```

`npm run dev` 同时启动 Vite 渲染层（5174 端口）和 Electron 主进程。

环境变量：

- `VOAH_WORKSPACE`：CLI 与 cache 所在的仓库根，默认上溯到 `desktop/voah-studio` 的两层父目录。

## 目录结构

```
electron/
  main.js          Electron 主进程入口
  preload.cjs      渲染层 contextBridge 白名单
  voahService.js   IPC handler：spawn voah CLI、读 manifest、reveal 路径

src/
  app/             路由 + 布局（侧边栏 + 主工作区）
  pages/           QueuePage 等
  features/        NewBatchDrawer 等高级特性
  components/      StageBar / StatusTag 等可复用原子
  hooks/           useStore（zustand 状态 + 轮询）
  lib/             阶段/状态展示元数据
  ipc/             （预留）
```

## 状态来源

前端不维护第二套任务状态，**以 manifest 文件为真源**。CLI 写什么，前端读什么。运行中批次每 2s 轮询 `batch_manifest.json` + 各 `task_manifest.json`，全空闲时降到 6s。

后续若有性能压力，再接 fs.watch 推送。
