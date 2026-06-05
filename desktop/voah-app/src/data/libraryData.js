import {
  buildProductCopyContext,
  createMockProductSaveResult,
  summarizeIntakeRun
} from "../lib/intakeSummary.js";

export const workspaceLibrarySnapshot = {
  schema_version: "voah-renderer-library-snapshot.v1",
  workspace_root_label: "~/混剪",
  source: "mock_from_local_cache_contract",
  cache_contract: {
    intake_run_pattern: "cache/voah_video_intake/{product_slug}/{timestamp}_{run_label}/",
    expected_artifacts: [
      "run_manifest.json",
      "assets.json",
      "story_units.json",
      "physical_shots.json",
      "embedding_results.json"
    ],
    renderer_visibility: {
      provider_access: "never",
      remote_clip_links: "never",
      local_paths: "artifact_reference_only"
    }
  }
};

export const productProfiles = [
  {
    id: "product_fangshai_qidian",
    name: "防晒气垫",
    brand: "Voah Demo",
    slug: "fangshai-qidian",
    source_folder: "原片/防晒气垫",
    status: "active",
    revision: 1,
    updated_at: "2026-06-05T20:23:01+08:00",
    claims: [
      {
        id: "claim_spf50",
        claim_type: "selling_point",
        title: "高倍防晒",
        body: "SPF50+ PA+++，适合通勤和户外补防晒场景。",
        priority: 1
      },
      {
        id: "claim_lightweight",
        claim_type: "selling_point",
        title: "轻薄贴肤",
        body: "上脸轻薄自然，减少厚重闷妆感。",
        priority: 2
      },
      {
        id: "claim_concealer",
        claim_type: "selling_point",
        title: "遮瑕持妆",
        body: "兼顾修饰肤色、遮瑕和日常持妆表现。",
        priority: 3
      },
      {
        id: "claim_shades",
        claim_type: "selling_point",
        title: "多色号可选",
        body: "覆盖常见肤色，便于自然提亮和补妆。",
        priority: 4
      },
      {
        id: "claim_portable",
        claim_type: "selling_point",
        title: "随身补妆",
        body: "气垫形态方便携带，适合外出补涂和快速补妆。",
        priority: 5
      },
      {
        id: "claim_offer_618",
        claim_type: "offer",
        title: "限时活动",
        body: "满 199 减 30，买一送替换芯。",
        priority: 1
      },
      {
        id: "claim_cta_order",
        claim_type: "cta",
        title: "下单提醒",
        body: "强调活动名额和替换芯福利，鼓励立即拍下。",
        priority: 1
      },
      {
        id: "claim_forbidden_medical",
        claim_type: "forbidden",
        title: "禁写医疗功效",
        body: "不能承诺治疗、修复疾病、100% 有效或绝对防晒。",
        priority: 1
      }
    ],
    copy_context: {
      top_limit: 5,
      copy_version: "v1.0 当前草稿"
    }
  }
];

const fangshaiQidianIntakeArtifacts = {
  run_manifest: {
    schema_version: "1.4.0-merged",
    stage: "merged_story_unit_intake",
    product: {
      name: "防晒气垫",
      slug: "fangshai-qidian"
    },
    outputs: {
      assets: "assets.json",
      story_units: "story_units.json",
      physical_shots: "physical_shots.json",
      embedding_results: "embedding_results.json"
    },
    qa: {
      asset_count: 5,
      story_unit_count: 51,
      physical_shot_count: 93,
      story_units_are_planning_granularity: true,
      vectorization_done: true,
      uploaded_physical_shot_count: 93,
      vectorization_input_count: 93,
      embedding_result_count: 93,
      embedding_channels_attempted: 485,
      embedding_channels_succeeded: 485,
      embedding_channels_failed: 0,
      embedding_channels_by_mode: {
        video: 93,
        text: 392
      },
      embedding_channels_by_channel: {
        video_chunk: 93,
        visual_summary: 93,
        source_meaning: 93,
        ocr: 49,
        tags: 93,
        asr: 64
      }
    },
    created_at: "2026-06-03T23:11:49+08:00"
  },
  assets: [],
  story_units: [],
  physical_shots: [],
  embedding_results: []
};

export const intakeRunSummaries = [
  summarizeIntakeRun({
    runDir: "cache/voah_video_intake/fangshai-qidian/20260603_225800_merged5_scene_candidates_v1",
    productSlug: "fangshai-qidian",
    runLabel: "20260603_225800_merged5_scene_candidates_v1",
    artifacts: fangshaiQidianIntakeArtifacts
  })
];

export const activeProductProfile = productProfiles[0];

export const activeProductCopyContext = buildProductCopyContext(activeProductProfile);

export const productSaveContract = createMockProductSaveResult(
  activeProductProfile,
  activeProductProfile.revision
);

export const copyGenerationContexts = [
  {
    schema_version: "voah-task-copy-context.v1",
    id: "task_context_fangshai_qidian_mainline_demo",
    task_slug: "mainline_tts_semantic_v1",
    product_slug: activeProductProfile.slug,
    source_intake_run_id: intakeRunSummaries[0].id,
    platform: "douyin",
    target_duration_range_s: [40, 50],
    objective: "带货短视频混剪",
    copy_context: activeProductCopyContext,
    kpi: {
      target_video_count: 200,
      qa_pass_required: true
    },
    kpi_exclusions: [
      "claims.selling_point",
      "claims.offer",
      "copy_inputs.selling_point_top",
      "copy_inputs.copy_version"
    ],
    next_consumers: ["voah-copy-brief"]
  }
];

export const libraryData = {
  workspace: workspaceLibrarySnapshot,
  products: productProfiles,
  active_product: activeProductProfile,
  intake_runs: intakeRunSummaries,
  copy_contexts: copyGenerationContexts,
  product_save_contract: productSaveContract
};
