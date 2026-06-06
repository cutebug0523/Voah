# Voah Desktop MVP

Voah 桌面端生产工具 MVP。

定位：

```text
只会点鼠标的新手操作员
  -> 选择可生产产品
  -> 创建批量任务
  -> 系统跑 dry-run recipe
  -> 查看产物来源链
  -> 失败时重试失败步骤
  -> 通过 QA gate 后进入成品库
```

当前版本只实现本地 MVP：

- Electron + React + Vite 应用骨架。
- 本地 JSON store。
- Product / TaskRun / JobRun / Artifact / QaGateReport。
- dry-run 生产 recipe。
- `verify:mvp` 自动验证。

不包含：

- 权限系统。
- 复杂角色体系。
- 真实模型调用。
- 真实视频渲染。
- API key 明文存储。

## Commands

```bash
npm run dev
npm run electron:local
npm run verify:mvp
npm run lint
npm run build
```
