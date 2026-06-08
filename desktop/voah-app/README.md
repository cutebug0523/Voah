# Voah Desktop

Voah 桌面端生产工作台。

当前桌面端已经不是纯 dry-run 壳子，而是把已验证的 Voah 主线固化成本地流程：

```text
产品 / 任务 brief
  -> 销售逻辑
  -> 连续口播
  -> MiniMax TTS
  -> audio_sections
  -> 素材召回 / 选片 / 填充
  -> 字幕计划
  -> HyperFrames 烧字幕
  -> QA gate
  -> 成品登记
```

详细使用说明见：

```text
../../docs/00-overview/Voah桌面端使用说明与功能介绍.md
```

## Commands

开发模式：

```bash
npm run dev
npm run electron:local
```

浏览器调试 Electron main 侧能力：

```bash
node scripts/dev-bridge.mjs
npm run dev
```

质量检查：

```bash
npm run lint
npm run build
npm run verify:mvp
```

## 本地数据

桌面端使用本机 JSON store，不把 API key 写进仓库。

Electron 本地数据位于应用 userData 下的 `voah-mvp/`。浏览器调试桥使用：

```text
~/Library/Application Support/Voah Chrome Dev/voah-mvp/
```

模型 key 可从以下位置读取：

```text
/Users/noah/混剪/.env
~/.voah/video_intake/.env
桌面端私有 model-keys.local.json
```

## 当前入口

- 工作台：看生产状态、失败任务、最近任务。
- 产品：选择产品并创建批量任务。
- 任务：查看步骤、产物来源链、失败原因和重试入口。
- 成品：打开通过 QA gate 的最终视频。
- 设置：维护模型 key、文案默认参数、TTS 参数、字幕 preset 和字体路径。
