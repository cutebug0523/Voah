const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /authorization/i,
  /credential/i,
  /password/i
];

const TEMPORARY_URL_KEY_PATTERNS = [
  /oss[_-]?url/i,
  /trimmed[_-]?oss[_-]?url/i,
  /signed[_-]?url/i,
  /temporary[_-]?url/i,
  /presigned[_-]?url/i,
  /upload[_-]?url/i
];

const HEAVY_PAYLOAD_KEY_PATTERNS = [
  /^embedding$/i
];

const TEMPORARY_URL_VALUE_PATTERNS = [
  /^oss:\/\//i,
  /X-Amz-Signature=/i,
  /Expires=/i
];

const DEFAULT_EMBEDDING_CHANNELS = [
  "video_chunk",
  "visual_summary",
  "source_meaning",
  "ocr",
  "asr",
  "tags"
];

export const INTAKE_SUMMARY_SCHEMA_VERSION = "renderer-intake-summary.v1";

export function summarizeIntakeRun({ runDir, productSlug, runLabel, artifacts = {} }) {
  const manifest = artifacts.run_manifest || artifacts.runManifest || {};
  const assets = normalizeArrayArtifact(artifacts.assets, "assets");
  const storyUnits = normalizeArrayArtifact(artifacts.story_units || artifacts.storyUnits, "story_units");
  const physicalShots = normalizeArrayArtifact(artifacts.physical_shots || artifacts.physicalShots, "physical_shots");
  const embeddingResults = normalizeArrayArtifact(
    artifacts.embedding_results || artifacts.embeddingResults,
    "embedding_results"
  );

  const product = normalizeProduct(manifest.product, productSlug);
  const qa = manifest.qa || {};
  const embeddingSummary = summarizeEmbeddingChannels({ qa, embeddingResults });
  const artifactAvailability = summarizeArtifactAvailability(artifacts, manifest.outputs);

  return {
    schema_version: INTAKE_SUMMARY_SCHEMA_VERSION,
    id: buildRunId(product.slug, runDir, runLabel),
    product,
    run_label: runLabel || manifest.run_label || inferRunLabel(runDir),
    run_dir: runDir,
    stage: manifest.stage || "voah-video-intake",
    status: normalizeRunStatus(manifest.status, qa, artifactAvailability),
    created_at: manifest.created_at || null,
    finished_at: manifest.finished_at || null,
    asset_count: numberFrom(qa.asset_count, assets.length),
    story_unit_count: numberFrom(qa.story_unit_count, storyUnits.length),
    physical_shot_count: numberFrom(qa.physical_shot_count, physicalShots.length),
    embedding_channel_count: embeddingSummary.channel_count,
    embedding_channels: embeddingSummary.channels,
    qa_status: normalizeQaStatus(qa, artifactAvailability),
    qa: stripRendererUnsafeFields(qa),
    artifact_availability: artifactAvailability,
    renderer_security: {
      provider_access_visible: false,
      remote_clip_links_visible: false,
      exposed_path_policy: "artifact_reference_only"
    },
    artifacts: toRendererArtifactRefs(artifactAvailability),
    warnings: buildRunWarnings({ qa, artifactAvailability, embeddingSummary })
  };
}

export function buildProductCopyContext(productProfile) {
  const claims = productProfile.claims || [];
  const byType = groupClaimsByType(claims);
  const sellingPoints = sortClaims(byType.selling_point);
  const offers = sortClaims(byType.offer);
  const ctas = sortClaims(byType.cta);
  const forbidden = sortClaims(byType.forbidden);

  return {
    schema_version: "voah-copy-context.v1",
    product: {
      name: productProfile.name,
      brand: productProfile.brand,
      slug: productProfile.slug,
      source_folder: productProfile.source_folder
    },
    claims: {
      selling_point: sellingPoints,
      offer: offers,
      cta: ctas,
      forbidden
    },
    copy_inputs: {
      selling_point_top: sellingPoints.slice(0, productProfile.copy_context?.top_limit || 5),
      active_offers: offers,
      cta_candidates: ctas,
      forbidden_terms: forbidden,
      copy_version: productProfile.copy_context?.copy_version || "draft"
    },
    task_context_contract: {
      intended_consumer: "voah-copy-brief",
      feeds_fields: [
        "product",
        "product_claims",
        "script_sections[].intention_copy",
        "script_sections[].required_meaning",
        "script_sections[].avoid"
      ],
      not_kpi_fields: ["selling_point_top", "active_offers", "copy_version"]
    }
  };
}

export function createMockProductSaveResult(productProfile, previousRevision = 0) {
  return {
    schema_version: "voah-product-save-result.v1",
    status: "mock_saved",
    persisted: false,
    revision: previousRevision + 1,
    product_slug: productProfile.slug,
    product_profile_path: `cache/voah_products/${productProfile.slug}/product_profile.json`,
    product_claims_path: `cache/voah_products/${productProfile.slug}/product_claims.json`,
    message: "当前前端仅定义保存合同，真实落盘应由 Electron Main / ProductService 完成。"
  };
}

export function stripRendererUnsafeFields(value) {
  if (Array.isArray(value)) {
    return value.map(stripRendererUnsafeFields);
  }

  if (typeof value === "string" && isTemporaryUrlValue(value)) {
    return null;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSensitiveKey(key) && !isTemporaryUrlKey(key) && !isHeavyPayloadKey(key))
      .map(([key, item]) => [key, stripRendererUnsafeFields(item)])
  );
}

export function hasRendererUnsafeFields(value) {
  const unsafeKeys = [];

  walkObject(value, (key, item) => {
    if (isSensitiveKey(key) || isTemporaryUrlKey(key) || isHeavyPayloadKey(key) || isTemporaryUrlValue(item)) {
      unsafeKeys.push(key);
    }
  });

  return unsafeKeys.length > 0;
}

function normalizeArrayArtifact(artifact, preferredKey) {
  if (Array.isArray(artifact)) {
    return artifact;
  }

  if (!artifact || typeof artifact !== "object") {
    return [];
  }

  if (Array.isArray(artifact[preferredKey])) {
    return artifact[preferredKey];
  }

  return [];
}

function normalizeProduct(product, fallbackSlug) {
  return {
    name: product?.name || fallbackSlug || "未命名产品",
    slug: product?.slug || fallbackSlug || "unknown-product"
  };
}

function summarizeEmbeddingChannels({ qa, embeddingResults }) {
  const channelsFromQa = Object.keys(qa.embedding_channels_by_channel || {});
  const channelsFromResults = new Set();

  embeddingResults.forEach((result) => {
    Object.keys(result.embeddings || {}).forEach((channel) => channelsFromResults.add(channel));
  });

  const channels = unique([...channelsFromQa, ...channelsFromResults, ...DEFAULT_EMBEDDING_CHANNELS])
    .filter((channel) => {
      const fromQa = qa.embedding_channels_by_channel?.[channel];
      return fromQa !== undefined || channelsFromResults.has(channel);
    })
    .map((channel) => ({
      channel,
      count: numberFrom(qa.embedding_channels_by_channel?.[channel], countEmbeddingChannel(embeddingResults, channel)),
      status: countFailedEmbeddingChannel(embeddingResults, channel) > 0 ? "partial" : "ok"
    }));

  return {
    channel_count: channels.length,
    channels
  };
}

function summarizeArtifactAvailability(artifacts, manifestOutputs = {}) {
  const expectedArtifacts = {
    run_manifest: "run_manifest.json",
    assets: manifestOutputs.assets || "assets.json",
    story_units: manifestOutputs.story_units || "story_units.json",
    physical_shots: manifestOutputs.physical_shots || "physical_shots.json",
    embedding_results: manifestOutputs.embedding_results || "embedding_results.json"
  };

  return Object.fromEntries(
    Object.entries(expectedArtifacts).map(([kind, filename]) => [
      kind,
      {
        kind,
        filename,
        available: Boolean(artifacts[kind] || artifacts[toCamelCase(kind)])
      }
    ])
  );
}

function toRendererArtifactRefs(artifactAvailability) {
  return Object.fromEntries(
    Object.entries(artifactAvailability).map(([kind, artifact]) => [
      kind,
      {
        kind,
        filename: artifact.filename,
        available: artifact.available
      }
    ])
  );
}

function normalizeRunStatus(status, qa, artifactAvailability) {
  if (status) {
    return status;
  }

  if (!artifactAvailability.run_manifest.available) {
    return "missing_manifest";
  }

  if (qa.vectorization_done || qa.embedding_result_count > 0) {
    return "ready";
  }

  return "indexed";
}

function normalizeQaStatus(qa, artifactAvailability) {
  const missingRequired = Object.values(artifactAvailability)
    .filter((artifact) => artifact.kind !== "embedding_results")
    .some((artifact) => !artifact.available);

  if (missingRequired) {
    return "needs_attention";
  }

  if (qa.embedding_channels_failed > 0) {
    return "warning";
  }

  return qa.status || "ok";
}

function buildRunWarnings({ qa, artifactAvailability, embeddingSummary }) {
  const warnings = [];

  Object.values(artifactAvailability).forEach((artifact) => {
    if (!artifact.available) {
      warnings.push(`缺少 ${artifact.filename}`);
    }
  });

  if (qa.embedding_channels_failed > 0) {
    warnings.push(`有 ${qa.embedding_channels_failed} 个 embedding channel 失败`);
  }

  if (embeddingSummary.channel_count === 0) {
    warnings.push("未识别到 embedding channel");
  }

  return warnings;
}

function groupClaimsByType(claims) {
  return claims.reduce((groups, claim) => {
    const type = claim.claim_type || "selling_point";
    return {
      ...groups,
      [type]: [...(groups[type] || []), claim]
    };
  }, {});
}

function sortClaims(claims = []) {
  return [...claims].sort((a, b) => (a.priority || 99) - (b.priority || 99));
}

function buildRunId(productSlug, runDir, runLabel) {
  const runName = inferRunLabel(runDir) || runLabel || "intake-run";
  return `${productSlug || "unknown"}:${runName}`;
}

function inferRunLabel(runDir) {
  if (!runDir) {
    return null;
  }

  return String(runDir).split("/").filter(Boolean).at(-1) || null;
}

function numberFrom(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function countEmbeddingChannel(embeddingResults, channel) {
  return embeddingResults.filter((result) => result.embeddings?.[channel]).length;
}

function countFailedEmbeddingChannel(embeddingResults, channel) {
  return embeddingResults.filter((result) => result.embeddings?.[channel]?.status === "failed").length;
}

function unique(items) {
  return [...new Set(items)];
}

function toCamelCase(value) {
  return value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function isTemporaryUrlKey(key) {
  return TEMPORARY_URL_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function isHeavyPayloadKey(key) {
  return HEAVY_PAYLOAD_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function isTemporaryUrlValue(value) {
  return typeof value === "string" && TEMPORARY_URL_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function walkObject(value, visitKey) {
  if (Array.isArray(value)) {
    value.forEach((item) => walkObject(item, visitKey));
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  Object.entries(value).forEach(([key, item]) => {
    visitKey(key, item);
    walkObject(item, visitKey);
  });
}
