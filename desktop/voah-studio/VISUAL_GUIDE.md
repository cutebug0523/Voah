# Voah Studio 视觉规范(前端基准)

> 所有桌面端模块必须遵循本规范,与已完成的「队列看板」保持一致。
> 已实现参考:desktop/voah-studio/src/pages/QueuePage.jsx、src/app/App.jsx、src/features/*。

## 整体风格

- **浅色现代 SaaS + 紧凑高密度**(Linear/Notion 取向),不是宽松休闲。
- 一屏尽量多看信息,少滚动。面向一天 150 条的盯盘场景。
- 基础字号 13px(`text-[13px]`),次要信息 11-12px,标题 15px。

## 配色(Tailwind 已配置,见 tailwind.config.js)

```
ink:   900 #0f172a / 700 #334155 / 500 #64748b / 400 #94a3b8 / 300 #cbd5e1   (文字/灰阶)
brand: 50 #eef2ff / 100 #e0e7ff / 500 #6366f1 / 600 #4f46e5 / 700 #4338ca    (主色 indigo)
状态:  ok #16a34a(绿) / warn #d97706(黄) / err #dc2626(红) / run #2563eb(蓝)
底:    bg-slate-100(页面) / bg-white(卡片) / border-slate-200(描边)
```

- 主按钮:`bg-brand-600 hover:bg-brand-700 text-white`
- 次按钮:`border border-slate-200 text-ink-700 hover:bg-slate-50`
- 危险/失败操作:`bg-err/10 text-err hover:bg-err/20`

## 布局骨架(已有,新模块填入主工作区)

```
左侧 w-52 固定导航(队列/产品/成品库/设置)+ 左下今日产能面板
主工作区:顶栏(h-14, 标题 + 右侧主操作按钮) + 内容区(overflow-y-auto p-6)
```

## 组件复用(已有,直接用,别重写)

- `StatusTag`(src/components/StatusTag.jsx)— 状态标签(完成/运行中/待审/失败)
- `StageBar`(src/components/StageBar.jsx)— 5 段阶段条
- 卡片:`bg-white rounded-xl border border-slate-200 shadow-sm`
- 抽屉(右侧滑出):参考 NewBatchDrawer / TaskDetailDrawer,`fixed inset-y-0 right-0 w-96`(详情用 w-[460px]),`translate-x-full` 控制开合,带 `bg-black/20` 遮罩
- 空状态:参考 QueuePage 的 EmptyHint(居中图标 + 标题 + 副说明)
- 表单字段:`label text-xs font-medium text-ink-700 mb-1.5` + `input/select px-3 py-2 rounded-lg border border-slate-200 focus:border-brand-500 focus:ring-1`

## 交互约定

- 主画面打开即用,默认走「快车道」(低心智)。高级选项默认折叠(`<details>` 或"高级"开关)。
- 列表行可点(整行点击进详情),行内操作按钮 `e.stopPropagation()` 防冒泡。
- 所有耗时操作(调 CLI)要有 loading 态(按钮文字变"启动中…"+ disabled)。
- 状态以 manifest 文件为真源,轮询刷新(运行中 2s,空闲 6s),不在前端维护第二套状态。

## 图标

Font Awesome 4.7(已在 index.html 引入),用 `<i className="fa fa-xxx" />`。常用:fa-list-ul(队列)、fa-cube(产品)、fa-film(成品库)、fa-cog(设置)、fa-play、fa-folder-open-o、fa-plus、fa-flask(打样)。
