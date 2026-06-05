import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Bell,
  BookOpenText,
  Captions,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  FileText,
  Folder,
  Gauge,
  Home,
  ListChecks,
  Mic2,
  MoreVertical,
  Pause,
  Play,
  RefreshCw,
  Scissors,
  Settings,
  Sparkles,
  Subtitles,
  UserRound
} from "lucide-react";
import {
  buildBatchProductionPayload,
  deriveProductionReadiness,
  PRODUCTION_READINESS_STATUSES
} from "./data/productionReadiness.js";

const navItems = [
  { key: "home", label: "首页", icon: Home },
  { key: "library", label: "素材库", icon: Archive },
  { key: "tasks", label: "任务", icon: ListChecks },
  { key: "copy", label: "文案", icon: FileText },
  { key: "tts", label: "TTS", icon: Mic2 },
  { key: "assembly", label: "混剪", icon: Scissors },
  { key: "captions", label: "字幕", icon: Captions },
  { key: "subtitle-removal", label: "视频去字幕", icon: Subtitles, badge: "预留" },
  { key: "settings", label: "设置", icon: Settings, bottom: true }
];

const pipeline = [
  { title: "素材入库", state: "done" },
  { title: "召回与规划", state: "done" },
  { title: "文案第一步", state: "active", note: "当前" },
  { title: "文案第二步", state: "todo" },
  { title: "TTS", state: "todo" },
  { title: "音频主轴", state: "todo" },
  { title: "字幕烧录", state: "todo" },
  { title: "渲染 QA", state: "todo" }
];

const artifacts = [
  { file: "copy_brief.json", type: "文案前提", preview: "{ 产品: 防晒气垫, 卖点: 5 }", status: "已就绪", statusType: "ok", updated: "10:41:12" },
  { file: "voice_script.json", type: "连续口播", preview: "防晒气垫来啦，高倍防晒...", status: "待生成", statusType: "idle", updated: "-" },
  { file: "tts_audio.json", type: "TTS 音频", preview: "speech-02-hd · happy · 1.1x", status: "待生成", statusType: "idle", updated: "-" },
  { file: "timeline_fill.json", type: "时间线填充", preview: "素材条 / 波形 / 片段预览", status: "待生成", statusType: "idle", updated: "-" },
  { file: "caption_plan.json", type: "字幕计划", preview: "方案 1 · 下方强调词", status: "待生成", statusType: "idle", updated: "-" },
  { file: "final_subtitled.mp4", type: "最终成片", preview: "40-50 秒 · 1080p · H.264", status: "待生成", statusType: "idle", updated: "-" }
];

const queue = [
  { time: "10:41:15", task: "copy_brief.json 校验", state: "完成", tone: "ok", cost: "0.6s" },
  { time: "10:40:58", task: "素材检索", state: "完成", tone: "ok", cost: "12.8s" },
  { time: "10:40:45", task: "结构规划", state: "完成", tone: "ok", cost: "8.4s" },
  { time: "10:39:01", task: "批量生产预检", state: "通过", tone: "ok", cost: "1m 32s" },
  { time: "10:38:22", task: "TTS 预热模型", state: "进行中", tone: "warn", cost: "23%" },
  { time: "10:38:05", task: "字幕模板加载", state: "等待中", tone: "idle", cost: "-" }
];

const presets = [
  { label: "气垫带货 A", desc: "40-50 秒 · 女声 happy · 字幕方案 1" },
  { label: "气垫短促 B", desc: "25-35 秒 · 快节奏 · 强 CTA" },
  { label: "测素材覆盖", desc: "不导出 · 只跑召回和时间线" }
];

const fitLabels = {
  good: "好配音",
  medium: "可配音",
  poor: "弱配音"
};

const riskLabels = {
  low: "低",
  bottom_conflict: "底部冲突",
  high: "高"
};

const qaLabels = {
  ok: "通过",
  warning: "Warning",
  blocking: "Blocking"
};

const EMBEDDING_DIMENSION = 2560;

const productionStatusLabels = {
  [PRODUCTION_READINESS_STATUSES.READY]: "可生产",
  [PRODUCTION_READINESS_STATUSES.NEEDS_CONFIRMATION]: "需确认",
  [PRODUCTION_READINESS_STATUSES.BLOCKED]: "阻断"
};

const libraryProducts = [
  {
    id: "fangshai-qidian",
    name: "防晒气垫",
    brand: "Voah Demo",
    slug: "fangshai-qidian",
    sourceFolder: "/Users/noah/混剪/气垫/防晒气垫",
    status: "warning",
    owner: "短视频批量生产",
    claims: ["SPF50+ PA+++", "轻薄不闷", "随身补妆", "自然遮瑕"],
    forbidden: "医疗功效词、绝对化用语、100% 有效",
    offer: "限时满 199 减 30；买一送替换芯",
    latestRunId: "fangshai-mainline",
    runs: [
      {
        id: "fangshai-mainline",
        label: "20260603_225800_merged5_scene_candidates_v1",
        createdAt: "2026-06-03 22:58",
        runDir: "cache/voah_video_intake/fangshai-qidian/20260603_225800_merged5_scene_candidates_v1",
        status: "warning",
        productionReady: true,
        productionNote: "可生产，最终 manifest 保留 warning",
        stats: {
          assets: 5,
          assetDuration: "3m 42s",
          storyUnits: 46,
          physicalShots: 83,
          embeddingChannels: 6,
          vectorDimension: EMBEDDING_DIMENSION,
          videoChunkCount: 46,
          vectorFailures: 0,
          candidateSegments: 91
        },
        qa: {
          status: "warning",
          warnings: 2,
          blockers: 0,
          checklist: [
            { key: "contact-sheet", label: "contact sheet", level: "ok", detail: "contact_sheet.jpg 已生成，覆盖 46 个 story unit" },
            { key: "last-frame", label: "末帧检查", level: "warning", detail: "2 个 physical shot 末帧贴近下个镜头，需人工复核" },
            { key: "boundary", label: "低视觉差异边界", level: "warning", detail: "scene_014 / scene_027 保留 warning，不阻断生产" },
            { key: "dimension", label: "向量化维度", level: "ok", detail: "qwen3-vl-embedding 统一 2560 维" },
            { key: "video-chunk", label: "video_chunk", level: "ok", detail: "46/46 原生 video embedding 完成，无失败" }
          ]
        },
        artifacts: ["run_manifest.json", "story_units.json", "physical_shots.json", "embedding_results.json"]
      },
      {
        id: "fangshai-boundary-regression",
        label: "20260603_002146_boundary_regression",
        createdAt: "2026-06-03 00:21",
        runDir: "cache/voah_video_intake/fangshai-qidian/20260603_002146_boundary_regression",
        status: "blocking",
        productionReady: false,
        productionNote: "不可生产，末帧 QA 阻断未解除",
        stats: {
          assets: 5,
          assetDuration: "3m 42s",
          storyUnits: 38,
          physicalShots: 71,
          embeddingChannels: 5,
          vectorDimension: EMBEDDING_DIMENSION,
          videoChunkCount: 31,
          vectorFailures: 7,
          candidateSegments: 88
        },
        qa: {
          status: "blocking",
          warnings: 3,
          blockers: 2,
          checklist: [
            { key: "contact-sheet", label: "contact sheet", level: "ok", detail: "contact_sheet.jpg 已生成" },
            { key: "last-frame", label: "末帧检查", level: "blocking", detail: "7 个片段末帧粘到下个镜头，不能进入生产" },
            { key: "boundary", label: "低视觉差异边界", level: "warning", detail: "多处近似静止画面需复核" },
            { key: "dimension", label: "向量化维度", level: "warning", detail: "文本通道维度一致，video_chunk 覆盖不足" },
            { key: "video-chunk", label: "video_chunk", level: "blocking", detail: "7 个 story unit 缺原生 video embedding" }
          ]
        },
        artifacts: ["run_manifest.json", "qa_last_frames.json", "embedding_results.json"]
      }
    ],
    storyUnits: [
      {
        id: "SU-001",
        asset: "M01",
        start: "00:04.2",
        end: "00:12.8",
        duration: 8.6,
        timeline_roles: ["开场钩子", "质地展示"],
        voiceover_fit: "good",
        hard_subtitle_risk: "low",
        can_standalone: true,
        visual_summary: "手持气垫打开外壳，粉扑贴近镜头，质地干净清透。",
        source_meaning: "展示产品便携和第一眼质感，适合作为开场建立商品识别。",
        physicalShots: [
          { id: "PS-001A", range: "00:04.2-00:07.6", usable: "3.2s", qa: "ok", note: "打开气垫，末帧干净", file: "trimmed_physical/M01_0042_0076.mp4" },
          { id: "PS-001B", range: "00:07.6-00:12.8", usable: "5.0s", qa: "ok", note: "粉扑近景，适合接卖点", file: "trimmed_physical/M01_0076_0128.mp4" }
        ]
      },
      {
        id: "SU-006",
        asset: "M02",
        start: "00:18.0",
        end: "00:29.4",
        duration: 11.4,
        timeline_roles: ["功效证明", "上脸效果"],
        voiceover_fit: "good",
        hard_subtitle_risk: "bottom_conflict",
        can_standalone: true,
        visual_summary: "模特半脸上妆对比，左侧肤色更均匀，右下角有原视频字幕。",
        source_meaning: "证明遮瑕与自然妆效，适合承接轻薄不厚重的口播。",
        physicalShots: [
          { id: "PS-006A", range: "00:18.0-00:23.2", usable: "4.9s", qa: "warning", note: "底部字幕区域与 Voah 字幕冲突", file: "trimmed_physical/M02_0180_0232.mp4" },
          { id: "PS-006B", range: "00:23.2-00:29.4", usable: "5.9s", qa: "ok", note: "可裁上半区避开字幕", file: "trimmed_physical/M02_0232_0294.mp4" }
        ]
      },
      {
        id: "SU-014",
        asset: "M03",
        start: "00:32.1",
        end: "00:37.0",
        duration: 4.9,
        timeline_roles: ["成分质感", "补妆动作"],
        voiceover_fit: "medium",
        hard_subtitle_risk: "low",
        can_standalone: false,
        visual_summary: "粉扑轻拍手背，展示粉体附着和轻薄肤感。",
        source_meaning: "补充质地细腻、服帖的证明，单独使用信息不完整。",
        physicalShots: [
          { id: "PS-014A", range: "00:32.1-00:34.4", usable: "2.1s", qa: "ok", note: "手背轻拍动作完整", file: "trimmed_physical/M03_0321_0344.mp4" },
          { id: "PS-014B", range: "00:34.4-00:37.0", usable: "2.4s", qa: "warning", note: "末帧接近下一镜头", file: "trimmed_physical/M03_0344_0370.mp4" }
        ]
      },
      {
        id: "SU-021",
        asset: "M04",
        start: "00:40.3",
        end: "00:48.9",
        duration: 8.6,
        timeline_roles: ["防晒证明", "户外场景"],
        voiceover_fit: "good",
        hard_subtitle_risk: "low",
        can_standalone: true,
        visual_summary: "户外阳光下手持气垫补妆，背景有强光和皮肤近景。",
        source_meaning: "把高倍防晒和随身补涂连接起来，适合中段卖点证明。",
        physicalShots: [
          { id: "PS-021A", range: "00:40.3-00:44.1", usable: "3.6s", qa: "ok", note: "户外强光环境", file: "trimmed_physical/M04_0403_0441.mp4" },
          { id: "PS-021B", range: "00:44.1-00:48.9", usable: "4.4s", qa: "ok", note: "补妆动作完整", file: "trimmed_physical/M04_0441_0489.mp4" }
        ]
      },
      {
        id: "SU-033",
        asset: "M05",
        start: "00:56.0",
        end: "01:05.2",
        duration: 9.2,
        timeline_roles: ["福利 CTA", "产品包装"],
        voiceover_fit: "medium",
        hard_subtitle_risk: "high",
        can_standalone: false,
        visual_summary: "桌面摆放气垫正装和替换芯，画面底部有大号活动字卡。",
        source_meaning: "展示套装和赠品信息，但原硬字幕较重，适合少量使用。",
        physicalShots: [
          { id: "PS-033A", range: "00:56.0-01:00.4", usable: "3.8s", qa: "warning", note: "底部活动字卡覆盖面积大", file: "trimmed_physical/M05_0560_1004.mp4" },
          { id: "PS-033B", range: "01:00.4-01:05.2", usable: "4.0s", qa: "warning", note: "可裁顶部产品区域", file: "trimmed_physical/M05_1004_1052.mp4" }
        ]
      }
    ]
  },
  {
    id: "lip-matte",
    name: "雾面口红",
    brand: "Voah Demo",
    slug: "lip-matte",
    sourceFolder: "/Users/noah/混剪/口红/雾面口红",
    status: "blocking",
    owner: "历史素材回归",
    claims: ["高显色", "丝绒雾面", "不拔干", "通勤色号"],
    forbidden: "绝对化持妆、医疗修复、虚假色号承诺",
    offer: "第二支半价，赠便携唇刷",
    latestRunId: "lip-blocked",
    runs: [
      {
        id: "lip-blocked",
        label: "20260604_114200_qa_blocking_v1",
        createdAt: "2026-06-04 11:42",
        runDir: "cache/voah_video_intake/lip-matte/20260604_114200_qa_blocking_v1",
        status: "blocking",
        productionReady: false,
        productionNote: "不可生产，vector/video_chunk 与末帧 QA 均有阻断",
        stats: {
          assets: 3,
          assetDuration: "2m 08s",
          storyUnits: 24,
          physicalShots: 49,
          embeddingChannels: 4,
          vectorDimension: EMBEDDING_DIMENSION,
          videoChunkCount: 18,
          vectorFailures: 6,
          candidateSegments: 61
        },
        qa: {
          status: "blocking",
          warnings: 4,
          blockers: 2,
          checklist: [
            { key: "contact-sheet", label: "contact sheet", level: "warning", detail: "contact sheet 缺少 3 个候选段缩略图" },
            { key: "last-frame", label: "末帧检查", level: "blocking", detail: "6 个片段末帧粘到下一镜头" },
            { key: "boundary", label: "低视觉差异边界", level: "warning", detail: "口红试色近景切点需要人工确认" },
            { key: "dimension", label: "向量化维度", level: "ok", detail: "qwen3-vl-embedding 统一 2560 维" },
            { key: "video-chunk", label: "video_chunk", level: "blocking", detail: "6 个 story unit 没有 video_chunk embedding" }
          ]
        },
        artifacts: ["run_manifest.json", "qa_last_frames.json", "embedding_results.json"]
      }
    ],
    storyUnits: [
      {
        id: "SU-101",
        asset: "L01",
        start: "00:08.0",
        end: "00:16.5",
        duration: 8.5,
        timeline_roles: ["开场钩子", "色号展示"],
        voiceover_fit: "good",
        hard_subtitle_risk: "low",
        can_standalone: true,
        visual_summary: "手臂试色四个色号，镜头稳定，色块清晰。",
        source_meaning: "快速建立口红色号丰富和显色度。",
        physicalShots: [
          { id: "PS-101A", range: "00:08.0-00:12.8", usable: "4.4s", qa: "ok", note: "色块清晰", file: "trimmed_physical/L01_0080_0128.mp4" },
          { id: "PS-101B", range: "00:12.8-00:16.5", usable: "3.1s", qa: "warning", note: "末帧轻微抖动", file: "trimmed_physical/L01_0128_0165.mp4" }
        ]
      },
      {
        id: "SU-118",
        asset: "L02",
        start: "00:33.2",
        end: "00:39.8",
        duration: 6.6,
        timeline_roles: ["上嘴效果", "功效证明"],
        voiceover_fit: "medium",
        hard_subtitle_risk: "bottom_conflict",
        can_standalone: true,
        visual_summary: "模特上嘴前后对比，底部有原视频口播字幕。",
        source_meaning: "证明雾面妆效和显色，但字幕区域需要处理。",
        physicalShots: [
          { id: "PS-118A", range: "00:33.2-00:36.7", usable: "2.8s", qa: "blocking", note: "末帧进入下个场景", file: "trimmed_physical/L02_0332_0367.mp4" },
          { id: "PS-118B", range: "00:36.7-00:39.8", usable: "2.4s", qa: "warning", note: "底部硬字幕冲突", file: "trimmed_physical/L02_0367_0398.mp4" }
        ]
      },
      {
        id: "SU-124",
        asset: "L03",
        start: "00:44.0",
        end: "00:48.1",
        duration: 4.1,
        timeline_roles: ["福利 CTA", "产品包装"],
        voiceover_fit: "poor",
        hard_subtitle_risk: "high",
        can_standalone: false,
        visual_summary: "包装盒和赠品平铺，背景活动贴纸占据画面下半部分。",
        source_meaning: "能说明赠品，但原始活动字卡干扰较大。",
        physicalShots: [
          { id: "PS-124A", range: "00:44.0-00:48.1", usable: "3.4s", qa: "warning", note: "可裁顶部包装区域", file: "trimmed_physical/L03_0440_0481.mp4" }
        ]
      }
    ]
  }
];

function StatusDot({ tone = "idle" }) {
  return <span className={`status-dot ${tone}`} />;
}

function Sidebar({ activePage, onNavigate }) {
  return (
    <aside className="sidebar">
      <div className="traffic-lights" aria-hidden="true">
        <span className="red" />
        <span className="yellow" />
        <span className="green" />
      </div>
      <nav className="nav-list">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={`nav-item ${activePage === item.key ? "active" : ""} ${item.bottom ? "nav-bottom" : ""}`}
              key={item.label}
              onClick={() => onNavigate(item.key)}
            >
              <Icon size={19} />
              <span>{item.label}</span>
              {item.badge && <em>{item.badge}</em>}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function Header({ activePage }) {
  const pageTitle = activePage === "library" ? "素材库" : "Voah 工作台";

  return (
    <header className="topbar">
      <div>
        <h1>{pageTitle}</h1>
        <button className="workspace-picker">
          <Folder size={16} />
          ~/VoahWorkspace
          <ChevronDown size={16} />
        </button>
      </div>
      <div className="top-status">
        <span><StatusDot tone="ok" /> 本地队列 4</span>
        <span><StatusDot tone="ok" /> API 配置正常</span>
        <span><StatusDot tone="accent" /> 缓存 12.4 GB</span>
        <button className="icon-button" aria-label="通知"><Bell size={18} /></button>
        <button className="icon-button" aria-label="用户"><UserRound size={18} /></button>
      </div>
    </header>
  );
}

function Pipeline() {
  return (
    <section className="pipeline" aria-label="Voah 管线状态">
      {pipeline.map((step, index) => (
        <div className={`pipeline-step ${step.state}`} key={step.title}>
          <span className="step-index">{index + 1}</span>
          <strong>{step.title}</strong>
          <small>{step.note || (step.state === "done" ? "完成" : "后台待跑")}</small>
        </div>
      ))}
    </section>
  );
}

function BatchLauncher({ readiness, onStartBatch }) {
  return (
    <section className="panel launcher-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">当前批量任务</p>
          <h2>防晒气垫混剪生产</h2>
        </div>
        <button className="ghost-button">
          复用上次配置
          <RefreshCw size={15} />
        </button>
      </div>

      <div className={`batch-readiness ${readiness.status}`}>
        <strong>{productionStatusLabels[readiness.status]}</strong>
        <span>
          {readiness.latest_intake_run_id || "暂无 intake run"}
          {readiness.requires_warning_confirmation ? " · 有 warning，开始前需确认" : ""}
          {readiness.blocking_reasons.length > 0 ? ` · ${readiness.blocking_reasons.length} 个阻断` : ""}
        </span>
      </div>

      <div className="launcher-grid">
        <label>
          <span>产品 / 素材库</span>
          <button className="select-like">防晒气垫 <ChevronDown size={15} /></button>
        </label>
        <label>
          <span>目标数量</span>
          <input defaultValue="200" inputMode="numeric" />
        </label>
        <label>
          <span>成片时长</span>
          <button className="select-like">40-50 秒 <ChevronDown size={15} /></button>
        </label>
        <label>
          <span>生产预设</span>
          <button className="select-like">气垫带货 A <ChevronDown size={15} /></button>
        </label>
      </div>

      <div className="preset-row">
        {presets.map((preset, index) => (
          <button className={`preset-card ${index === 0 ? "selected" : ""}`} key={preset.label}>
            <strong>{preset.label}</strong>
            <span>{preset.desc}</span>
          </button>
        ))}
      </div>

      <div className="checklist">
        <div><CheckCircle2 size={16} /> 素材库 5 条原片 / 46 个 story unit 可用</div>
        <div><CheckCircle2 size={16} /> 文案输入上下文已配置</div>
        <div><CheckCircle2 size={16} /> 音色 moss_audio_aaa... · happy · speed 1.1</div>
        <div><AlertTriangle size={16} /> 视频去字幕模块为预留，不进入本次生产</div>
      </div>

      <div className="launcher-actions">
        <button className="primary-button" disabled={!readiness.can_enter_production} onClick={onStartBatch}>
          <Play size={18} />
          开始批量生产
        </button>
        <button className="secondary-button">只跑 3 条测试</button>
        <span>预计占用并发 4，失败任务自动停在 QA。</span>
      </div>
    </section>
  );
}

function CopyContext() {
  return (
    <section className="panel context-panel">
      <div className="panel-head slim">
        <div>
          <p className="eyebrow">文案生成输入</p>
          <h3>文案输入上下文</h3>
        </div>
        <button className="text-button">使用模板 <ChevronRight size={15} /></button>
      </div>
      <div className="context-table">
        <div>
          <span>产品名</span>
          <strong>防晒气垫 SPF50+ PA+++</strong>
        </div>
        <div>
          <span>卖点 TOP</span>
          <ol>
            <li>高倍防晒，长效抵御紫外线</li>
            <li>轻薄贴肤，不闷痘，妆感自然</li>
            <li>遮瑕不易脱妆，持妆特色</li>
            <li>多色号可选，贴合亚洲肤色</li>
            <li>随身补妆方便，妆养合一</li>
          </ol>
        </div>
        <div>
          <span>活动优惠</span>
          <strong>限时满 199 减 30；买一送替换芯</strong>
        </div>
        <div>
          <span>文案版本</span>
          <strong>v1.0 当前草稿</strong>
        </div>
        <div>
          <span>禁写项</span>
          <strong>医疗功效词、绝对化用语、100% 有效</strong>
        </div>
      </div>
    </section>
  );
}

function Artifacts() {
  return (
    <section className="panel artifact-panel">
      <div className="panel-head slim">
        <div>
          <p className="eyebrow">下一步承接</p>
          <h3>最近产物</h3>
        </div>
        <button className="text-button">打开产物目录 <ChevronRight size={15} /></button>
      </div>
      <div className="artifact-table">
        <div className="table-row table-head">
          <span>产物文件</span>
          <span>类型</span>
          <span>预览</span>
          <span>更新时间</span>
          <span>状态</span>
          <span>操作</span>
        </div>
        {artifacts.map((artifact) => (
          <div className="table-row" key={artifact.file}>
            <span className="file-name"><BookOpenText size={15} /> {artifact.file}</span>
            <span>{artifact.type}</span>
            <span className="preview-cell">{artifact.preview}</span>
            <span>{artifact.updated}</span>
            <span className={`status-pill ${artifact.statusType}`}>{artifact.status}</span>
            <button className="icon-button small" aria-label={`${artifact.file} 操作`}><MoreVertical size={16} /></button>
          </div>
        ))}
      </div>
    </section>
  );
}

function QueuePanel() {
  return (
    <section className="panel queue-panel">
      <div className="panel-head slim">
        <div>
          <p className="eyebrow">本地 worker</p>
          <h3>队列</h3>
        </div>
        <button className="text-button">全部日志</button>
      </div>
      <div className="queue-list">
        {queue.map((item) => (
          <div className="queue-item" key={`${item.time}-${item.task}`}>
            <span>{item.time}</span>
            <strong>{item.task}</strong>
            <em><StatusDot tone={item.tone} /> {item.state}</em>
            <small>{item.cost}</small>
          </div>
        ))}
      </div>
      <div className="queue-footer">
        <label>
          并发数
          <button className="select-like compact">4 <ChevronDown size={14} /></button>
        </label>
        <button className="secondary-button small-action"><Pause size={15} /> 暂停队列</button>
      </div>
    </section>
  );
}

function StatStrip() {
  return (
    <section className="stat-strip">
      <div><Database size={17} /><strong>素材库健康</strong><span>46 单元可用</span></div>
      <div><Copy size={17} /><strong>今日批次</strong><span>0 / 200</span></div>
      <div><Gauge size={17} /><strong>预计耗时</strong><span>约 3h 20m</span></div>
      <div><Sparkles size={17} /><strong>预留模块</strong><span>视频去字幕</span></div>
    </section>
  );
}

function HomePage({ readiness, onStartBatch }) {
  return (
    <div className="content">
      <Pipeline />
      <StatStrip />
      <div className="main-grid">
        <BatchLauncher readiness={readiness} onStartBatch={onStartBatch} />
        <CopyContext />
        <Artifacts />
        <QueuePanel />
      </div>
    </div>
  );
}

function getStatusTone(status) {
  if (status === "ok") return "ok";
  if (status === "warning") return "warn";
  if (status === "blocking") return "danger";
  return "idle";
}

function getDurationLabel(value) {
  if (value === "short") return "短素材 < 5s";
  if (value === "medium") return "5-10s";
  if (value === "long") return "长素材 > 10s";
  return "全部时长";
}

function matchDuration(duration, filter) {
  if (filter === "short") return duration < 5;
  if (filter === "medium") return duration >= 5 && duration <= 10;
  if (filter === "long") return duration > 10;
  return true;
}

function getProductReadiness(product, selectedRun) {
  return deriveProductionReadiness({
    product: {
      id: product.id,
      name: product.name,
      latest_intake_run_id: selectedRun.id
    },
    product_claims: product.claims.map((claim, index) => ({
      id: `${product.id}_claim_${index}`,
      claim_type: "selling_point",
      title: claim,
      body: claim,
      priority: index + 1
    })),
    intake_runs: [
      {
        id: selectedRun.id,
        run_label: selectedRun.label,
        run_dir: selectedRun.runDir,
        status: selectedRun.productionReady ? "warning" : "failed",
        qa_status: selectedRun.qa.status,
        asset_count: selectedRun.stats.assets,
        story_unit_count: selectedRun.stats.storyUnits,
        physical_shot_count: selectedRun.stats.physicalShots,
        embedding_channel_count: selectedRun.stats.embeddingChannels,
        artifacts: selectedRun.artifacts.map((artifact) => artifact.replace(/\\.json$/u, "")),
        warnings: selectedRun.qa.warnings > 0 ? [`${selectedRun.qa.warnings} 个 QA warning`] : [],
        blocking_failures: selectedRun.qa.blockers > 0 ? [`${selectedRun.qa.blockers} 个 blocking failure`] : []
      }
    ]
  });
}

function ProductList({ products, selectedProductId, onSelectProduct }) {
  return (
    <section className="panel product-list-panel">
      <div className="panel-head slim">
        <div>
          <p className="eyebrow">产品</p>
          <h3>素材资产</h3>
        </div>
        <button className="icon-button small" aria-label="刷新产品列表"><RefreshCw size={15} /></button>
      </div>
      <div className="product-list">
        {products.map((product) => {
          const latestRun = product.runs.find((run) => run.id === product.latestRunId) || product.runs[0];
          return (
            <button
              className={`product-card ${selectedProductId === product.id ? "selected" : ""}`}
              key={product.id}
              onClick={() => onSelectProduct(product.id)}
            >
              <span className={`product-status-line ${product.status}`} />
              <strong>{product.name}</strong>
              <small>{product.brand} · {product.slug}</small>
              <div>
                <span><StatusDot tone={getStatusTone(product.status)} /> {latestRun.productionReady ? "可生产" : "不可生产"}</span>
                <em>{latestRun.stats.storyUnits} story units</em>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ProductDetail({ product, selectedRun, onSelectRun, draftProfile, onDraftProfileChange, saveState, onSaveProfile }) {
  return (
    <section className="panel library-detail-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">产品详情</p>
          <h2>{product.name}</h2>
        </div>
        <span className={`status-pill ${selectedRun.productionReady ? "ok" : "blocking"}`}>
          {selectedRun.productionReady ? "可生产" : "生产锁定"}
        </span>
      </div>

      <div className="product-meta-grid">
        <div>
          <span>brand</span>
          <input
            value={draftProfile.brand}
            onChange={(event) => onDraftProfileChange({ brand: event.target.value })}
          />
        </div>
        <div>
          <span>slug</span>
          <strong>{product.slug}</strong>
        </div>
        <div className="wide">
          <span>source folder</span>
          <input
            value={draftProfile.sourceFolder}
            onChange={(event) => onDraftProfileChange({ sourceFolder: event.target.value })}
          />
        </div>
        <div>
          <span>活动优惠</span>
          <input
            value={draftProfile.offer}
            onChange={(event) => onDraftProfileChange({ offer: event.target.value })}
          />
        </div>
        <div className="wide">
          <span>禁写项</span>
          <input
            value={draftProfile.forbidden}
            onChange={(event) => onDraftProfileChange({ forbidden: event.target.value })}
          />
        </div>
      </div>

      <div className="claim-row">
        {product.claims.map((claim) => (
          <span key={claim}>{claim}</span>
        ))}
      </div>

      <div className="profile-save-row">
        <button className="secondary-button" onClick={onSaveProfile}>
          保存产品资料
        </button>
        <span className={saveState.status}>{saveState.message}</span>
      </div>

      <div className="run-section">
        <div className="section-title-row">
          <h3>Intake run</h3>
          <button className="text-button">查看 manifest <ChevronRight size={15} /></button>
        </div>
        <div className="run-list">
          {product.runs.map((run) => (
            <button
              className={`run-card ${selectedRun.id === run.id ? "selected" : ""} ${run.status}`}
              key={run.id}
              onClick={() => onSelectRun(run.id)}
            >
              <div>
                <strong>{run.label}</strong>
                <small>{run.createdAt}</small>
              </div>
              <span className={`status-pill ${run.status}`}>{qaLabels[run.status]}</span>
              <em>{run.productionReady ? "可生产" : "不可生产"}</em>
            </button>
          ))}
        </div>
      </div>

      <div className="library-stats">
        <div><Database size={17} /><strong>{selectedRun.stats.assets}</strong><span>原片</span></div>
        <div><Gauge size={17} /><strong>{selectedRun.stats.assetDuration}</strong><span>总时长</span></div>
        <div><Archive size={17} /><strong>{selectedRun.stats.storyUnits}</strong><span>StoryUnit</span></div>
        <div><Scissors size={17} /><strong>{selectedRun.stats.physicalShots}</strong><span>PhysicalShot</span></div>
        <div><Copy size={17} /><strong>{selectedRun.stats.embeddingChannels}</strong><span>向量通道</span></div>
        <div><FileText size={17} /><strong>{selectedRun.stats.candidateSegments}</strong><span>候选切点</span></div>
      </div>
    </section>
  );
}

function QaPanel({ run, readiness, onStartBatch }) {
  return (
    <section className="panel qa-panel">
      <div className="panel-head slim">
        <div>
          <p className="eyebrow">入库 QA</p>
          <h3>生产门禁</h3>
        </div>
        <span className={`status-pill ${run.status}`}>{qaLabels[run.status]}</span>
      </div>

      <div className={`production-gate ${run.productionReady ? "ready" : "blocked"}`}>
        {run.productionReady ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
        <div>
          <strong>{run.productionReady ? "可进入批量生产" : "不可进入批量生产"}</strong>
          <span>{run.productionNote}</span>
        </div>
      </div>

      <div className="qa-summary">
        <div>
          <span>warning</span>
          <strong>{run.qa.warnings}</strong>
        </div>
        <div>
          <span>blocking failure</span>
          <strong>{run.qa.blockers}</strong>
        </div>
      </div>

      <div className="qa-checklist">
        {run.qa.checklist.map((item) => (
          <div className={`qa-item ${item.level}`} key={item.key}>
            {item.level === "ok" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            <div>
              <strong>{item.label}</strong>
              <span>{item.detail}</span>
            </div>
            <em>{qaLabels[item.level]}</em>
          </div>
        ))}
      </div>

      <div className="vector-box">
        <div>
          <span>video_chunk</span>
          <strong>{run.stats.videoChunkCount}/{run.stats.storyUnits}</strong>
        </div>
        <div>
          <span>dimension</span>
          <strong>{run.stats.vectorDimension}</strong>
        </div>
        <div>
          <span>failures</span>
          <strong>{run.stats.vectorFailures}</strong>
        </div>
      </div>

      <div className="artifact-chip-row">
        {run.artifacts.map((artifact) => (
          <span key={artifact}>{artifact}</span>
        ))}
      </div>

      <button className="secondary-button full-width" disabled={!readiness.can_enter_production} onClick={onStartBatch}>
        {readiness.can_enter_production ? "带入批量生产" : "阻断失败未解除"}
      </button>
    </section>
  );
}

function StoryUnitTable({ storyUnits }) {
  const [roleFilter, setRoleFilter] = useState("all");
  const [fitFilter, setFitFilter] = useState("all");
  const [riskFilter, setRiskFilter] = useState("all");
  const [standaloneFilter, setStandaloneFilter] = useState("all");
  const [durationFilter, setDurationFilter] = useState("all");
  const [expandedUnits, setExpandedUnits] = useState(() => new Set(["SU-001"]));

  const roleOptions = useMemo(() => {
    const roles = new Set();
    storyUnits.forEach((unit) => unit.timeline_roles.forEach((role) => roles.add(role)));
    return Array.from(roles);
  }, [storyUnits]);

  const filteredUnits = useMemo(() => {
    return storyUnits.filter((unit) => {
      const roleMatches = roleFilter === "all" || unit.timeline_roles.includes(roleFilter);
      const fitMatches = fitFilter === "all" || unit.voiceover_fit === fitFilter;
      const riskMatches = riskFilter === "all" || unit.hard_subtitle_risk === riskFilter;
      const standaloneMatches =
        standaloneFilter === "all" || String(unit.can_standalone) === standaloneFilter;
      return roleMatches && fitMatches && riskMatches && standaloneMatches && matchDuration(unit.duration, durationFilter);
    });
  }, [durationFilter, fitFilter, riskFilter, roleFilter, standaloneFilter, storyUnits]);

  function resetFilters() {
    setRoleFilter("all");
    setFitFilter("all");
    setRiskFilter("all");
    setStandaloneFilter("all");
    setDurationFilter("all");
  }

  function toggleUnit(unitId) {
    setExpandedUnits((current) => {
      const next = new Set(current);
      if (next.has(unitId)) {
        next.delete(unitId);
      } else {
        next.add(unitId);
      }
      return next;
    });
  }

  return (
    <section className="panel story-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">StoryUnit 主视角</p>
          <h2>素材理解与筛选</h2>
        </div>
        <span className="count-pill">{filteredUnits.length} / {storyUnits.length} units</span>
      </div>

      <div className="filter-bar">
        <label>
          <span>timeline_roles</span>
          <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
            <option value="all">全部角色</option>
            {roleOptions.map((role) => (
              <option value={role} key={role}>{role}</option>
            ))}
          </select>
        </label>
        <label>
          <span>voiceover_fit</span>
          <select value={fitFilter} onChange={(event) => setFitFilter(event.target.value)}>
            <option value="all">全部</option>
            <option value="good">{fitLabels.good}</option>
            <option value="medium">{fitLabels.medium}</option>
            <option value="poor">{fitLabels.poor}</option>
          </select>
        </label>
        <label>
          <span>hard_subtitle_risk</span>
          <select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value)}>
            <option value="all">全部</option>
            <option value="low">{riskLabels.low}</option>
            <option value="bottom_conflict">{riskLabels.bottom_conflict}</option>
            <option value="high">{riskLabels.high}</option>
          </select>
        </label>
        <label>
          <span>can_standalone</span>
          <select value={standaloneFilter} onChange={(event) => setStandaloneFilter(event.target.value)}>
            <option value="all">全部</option>
            <option value="true">可独立</option>
            <option value="false">需拼接</option>
          </select>
        </label>
        <label>
          <span>duration</span>
          <select value={durationFilter} onChange={(event) => setDurationFilter(event.target.value)}>
            <option value="all">{getDurationLabel("all")}</option>
            <option value="short">{getDurationLabel("short")}</option>
            <option value="medium">{getDurationLabel("medium")}</option>
            <option value="long">{getDurationLabel("long")}</option>
          </select>
        </label>
        <button className="ghost-button reset-filter" onClick={resetFilters}>
          <RefreshCw size={15} />
          重置
        </button>
      </div>

      <div className="story-table">
        <div className="story-row story-head">
          <span />
          <span>Unit</span>
          <span>角色</span>
          <span>画面描述</span>
          <span>原含义</span>
          <span>硬字幕风险</span>
          <span>可配音程度</span>
          <span>独立使用</span>
          <span>可用时长</span>
        </div>
        {filteredUnits.length === 0 && (
          <div className="empty-state">当前筛选没有匹配的 story unit。</div>
        )}
        {filteredUnits.map((unit) => {
          const isExpanded = expandedUnits.has(unit.id);
          return (
            <React.Fragment key={unit.id}>
              <div className="story-row">
                <button className="icon-button small" onClick={() => toggleUnit(unit.id)} aria-label={`${unit.id} physical shots`}>
                  <ChevronRight className={isExpanded ? "expanded-chevron" : ""} size={16} />
                </button>
                <strong className="unit-key">{unit.id}<small>{unit.asset}</small></strong>
                <span className="role-stack">
                  {unit.timeline_roles.map((role) => <em key={role}>{role}</em>)}
                </span>
                <span className="long-cell">{unit.visual_summary}</span>
                <span className="long-cell">{unit.source_meaning}</span>
                <span className={`risk-pill ${unit.hard_subtitle_risk}`}>{riskLabels[unit.hard_subtitle_risk]}</span>
                <span className={`fit-pill ${unit.voiceover_fit}`}>{fitLabels[unit.voiceover_fit]}</span>
                <span className={`status-pill ${unit.can_standalone ? "ok" : "idle"}`}>{unit.can_standalone ? "可独立" : "需拼接"}</span>
                <span>{unit.duration.toFixed(1)}s</span>
              </div>
              {isExpanded && (
                <div className="physical-shot-list">
                  {unit.physicalShots.map((shot) => (
                    <div className={`physical-shot ${shot.qa}`} key={shot.id}>
                      <strong>{shot.id}</strong>
                      <span>{shot.range}</span>
                      <span>{shot.usable}</span>
                      <span>{shot.note}</span>
                      <em>{qaLabels[shot.qa]}</em>
                      <small>{shot.file}</small>
                    </div>
                  ))}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </section>
  );
}

function LibraryPage() {
  const [selectedProductId, setSelectedProductId] = useState(libraryProducts[0].id);
  const selectedProduct = useMemo(
    () => libraryProducts.find((product) => product.id === selectedProductId) || libraryProducts[0],
    [selectedProductId]
  );
  const [selectedRunId, setSelectedRunId] = useState(selectedProduct.latestRunId);
  const [draftProfiles, setDraftProfiles] = useState(() =>
    Object.fromEntries(
      libraryProducts.map((product) => [
        product.id,
        {
          brand: product.brand,
          sourceFolder: product.sourceFolder,
          offer: product.offer,
          forbidden: product.forbidden
        }
      ])
    )
  );
  const [saveState, setSaveState] = useState({ status: "idle", message: "未保存" });
  const [intakeState, setIntakeState] = useState({ status: "idle", message: "等待创建入库 run" });

  const selectedRun = useMemo(() => {
    return selectedProduct.runs.find((run) => run.id === selectedRunId) || selectedProduct.runs[0];
  }, [selectedProduct, selectedRunId]);
  const draftProfile = draftProfiles[selectedProduct.id];
  const readiness = useMemo(() => getProductReadiness(selectedProduct, selectedRun), [selectedProduct, selectedRun]);

  function handleSelectProduct(productId) {
    const nextProduct = libraryProducts.find((product) => product.id === productId) || libraryProducts[0];
    setSelectedProductId(nextProduct.id);
    setSelectedRunId(nextProduct.latestRunId);
    setSaveState({ status: "idle", message: "未保存" });
    setIntakeState({ status: "idle", message: "等待创建入库 run" });
  }

  function handleDraftProfileChange(patch) {
    setDraftProfiles((current) => ({
      ...current,
      [selectedProduct.id]: {
        ...current[selectedProduct.id],
        ...patch
      }
    }));
  }

  async function handleSaveProfile() {
    const profile = {
      id: selectedProduct.id,
      name: selectedProduct.name,
      brand: draftProfile.brand,
      slug: selectedProduct.slug,
      source_folder: draftProfile.sourceFolder,
      offer: draftProfile.offer,
      forbidden: draftProfile.forbidden,
      claims: selectedProduct.claims,
      revision: 1
    };

    setSaveState({ status: "running", message: "保存中..." });
    try {
      const result = window.voah?.products?.saveProfile
        ? await window.voah.products.saveProfile(profile)
        : { persisted: false, message: "浏览器预览模式：已通过前端 contract 校验，未写入本机。" };
      setSaveState({
        status: result.persisted ? "ok" : "warning",
        message: result.message
      });
    } catch (error) {
      setSaveState({ status: "blocking", message: error.message });
    }
  }

  async function handleCreateIntakeRun() {
    setIntakeState({ status: "running", message: "创建受控 job contract..." });
    try {
      const payload = {
        product_id: selectedProduct.id,
        source_folder: draftProfile.sourceFolder,
        source_folder_origin: "user_selected",
        run_label: "desktop_intake_preview",
        options: {
          scene_threshold: 0.36,
          candidate_min_duration_s: 1.2,
          trim_story_units: true,
          generate_physical_shots: true,
          upload_for_video_embedding: true
        }
      };
      const result = window.voah?.intake?.createRun
        ? await window.voah.intake.createRun(payload)
        : { accepted: true, note: "浏览器预览模式：已创建前端 job contract，未执行 worker。" };
      setIntakeState({
        status: result.accepted ? "ok" : "warning",
        message: result.note
      });
    } catch (error) {
      setIntakeState({ status: "blocking", message: error.message });
    }
  }

  function handleStartBatch() {
    try {
      const payload = buildBatchProductionPayload(readiness, {
        confirm_warnings: true,
        task_defaults: {
          platform: "douyin",
          objective: "带货短视频混剪",
          target_count: 200,
          target_duration_min_s: 40,
          target_duration_max_s: 50,
          production_preset_id: "qidian-sales-a"
        }
      });
      setIntakeState({
        status: "ok",
        message: `已生成批量生产 payload：${payload.product_id} / ${payload.latest_intake_run_id}`
      });
    } catch (error) {
      setIntakeState({ status: "blocking", message: error.message });
    }
  }

  return (
    <div className="content library-page">
      <section className="library-hero">
        <div>
          <p className="eyebrow">常驻素材库</p>
          <h2>产品、入库 run、QA 与 StoryUnit</h2>
        </div>
        <div className="library-hero-actions">
          <button className="secondary-button"><Folder size={16} /> 绑定素材目录</button>
          <button className="primary-button" onClick={handleCreateIntakeRun}><Play size={17} /> 新建入库 run</button>
        </div>
      </section>
      <div className={`library-action-note ${intakeState.status}`}>{intakeState.message}</div>

      <div className="library-shell">
        <ProductList products={libraryProducts} selectedProductId={selectedProduct.id} onSelectProduct={handleSelectProduct} />
        <ProductDetail
          product={selectedProduct}
          selectedRun={selectedRun}
          onSelectRun={setSelectedRunId}
          draftProfile={draftProfile}
          onDraftProfileChange={handleDraftProfileChange}
          saveState={saveState}
          onSaveProfile={handleSaveProfile}
        />
        <QaPanel run={selectedRun} readiness={readiness} onStartBatch={handleStartBatch} />
      </div>

      <StoryUnitTable storyUnits={selectedProduct.storyUnits} />
    </div>
  );
}

export default function App() {
  const [activePage, setActivePage] = useState("home");
  const defaultProduct = libraryProducts[0];
  const defaultRun = defaultProduct.runs.find((run) => run.id === defaultProduct.latestRunId) || defaultProduct.runs[0];
  const defaultReadiness = getProductReadiness(defaultProduct, defaultRun);

  function handleHomeStartBatch() {
    buildBatchProductionPayload(defaultReadiness, {
      confirm_warnings: true,
      task_defaults: {
        platform: "douyin",
        objective: "带货短视频混剪",
        target_count: 200,
        target_duration_min_s: 40,
        target_duration_max_s: 50,
        production_preset_id: "qidian-sales-a"
      }
    });
  }

  const page = activePage === "library"
    ? <LibraryPage />
    : <HomePage readiness={defaultReadiness} onStartBatch={handleHomeStartBatch} />;

  return (
    <div className="app-shell">
      <Sidebar activePage={activePage} onNavigate={setActivePage} />
      <main className="workspace">
        <Header activePage={activePage} />
        {page}
      </main>
    </div>
  );
}
