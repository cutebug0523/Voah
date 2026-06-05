export const CONTRACT_SCHEMA_VERSION = "1.0.0";

export const INTAKE_JOB_KIND = "voah.intake.job_request";
export const INTAKE_STAGE = "video_intake";

export const INTAKE_RENDERER_STATUSES = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELED: "canceled"
});

export const WORKER_JOB_STATUSES = Object.freeze({
  CREATED: "created",
  QUEUED: "queued",
  RUNNING: "running",
  AWAITING_REVIEW: "awaiting_review",
  SUCCEEDED: "succeeded",
  WARNING: "warning",
  FAILED: "failed",
  CANCELLED: "cancelled",
  CANCELED: "canceled",
  STALE: "stale"
});

export const INTAKE_ARTIFACT_KINDS = Object.freeze({
  INTAKE_MANIFEST: "intake_manifest",
  ASSETS: "assets",
  SCENE_SEGMENTS_RAW: "scene_segments_raw",
  SCENE_SEGMENTS_MERGED: "scene_segments_merged",
  STORY_UNITS: "story_units",
  PHYSICAL_SHOTS: "physical_shots",
  VECTORIZATION_INPUTS: "vectorization_inputs",
  EMBEDDING_RESULTS: "embedding_results",
  SHOT_INDEX: "shot_index",
  QA_REPORT: "qa_report"
});

export const INTAKE_DEFAULT_OPTIONS = Object.freeze({
  scene_threshold: 0.36,
  candidate_min_duration_s: 1.2,
  trim_story_units: true,
  generate_physical_shots: true,
  upload_for_video_embedding: true,
  embedding_channels: Object.freeze([
    "video_chunk",
    "visual_summary",
    "source_meaning",
    "asr",
    "ocr",
    "tags"
  ]),
  qa_checks: Object.freeze([
    "contact_sheet",
    "last_frames",
    "boundary_delta",
    "manifest_schema"
  ])
});

export const INTAKE_CONSTRAINTS = Object.freeze({
  renderer_may_execute_shell: false,
  renderer_may_read_secrets: false,
  renderer_may_write_cache_artifacts: false,
  target_dir_must_be_user_selected: true,
  product_identity_source: "product_record_or_user_selected_folder",
  artifact_registration_service: "ArtifactService",
  dispatch_service: "IntakeService",
  runner_service: "WorkerRunner"
});

const REQUEST_ALLOWED_KEYS = new Set([
  "request_id",
  "submitted_at",
  "product_id",
  "source_folder",
  "source_folder_origin",
  "run_label",
  "options"
]);

const CANONICAL_REQUEST_ALLOWED_KEYS = new Set([
  "schema_version",
  "kind",
  "request_id",
  "submitted_at",
  "renderer_status",
  "product_id",
  "source_folder",
  "source_folder_origin",
  "run_label",
  "options",
  "constraints"
]);

const INTAKE_OPTION_ALLOWED_KEYS = new Set([
  "scene_threshold",
  "candidate_min_duration_s",
  "trim_story_units",
  "generate_physical_shots",
  "upload_for_video_embedding",
  "embedding_channels",
  "qa_checks"
]);

const ALLOWED_EMBEDDING_CHANNELS = new Set(INTAKE_DEFAULT_OPTIONS.embedding_channels);
const ALLOWED_QA_CHECKS = new Set(INTAKE_DEFAULT_OPTIONS.qa_checks);
const FORBIDDEN_SECRET_KEY_PARTS = [
  "api_key",
  "apikey",
  "secret",
  "token",
  "authorization",
  "password"
];

export function createIntakeJobRequest(payload) {
  assertPlainObject(payload, "payload");
  assertAllowedKeys(payload, REQUEST_ALLOWED_KEYS, "payload");
  assertNoSecretFields(payload, "payload");

  const sourceFolderOrigin = optionalString(
    payload.source_folder_origin,
    "payload.source_folder_origin"
  ) || "user_selected";

  if (sourceFolderOrigin !== "user_selected") {
    throw new TypeError("source_folder_origin must be user_selected");
  }

  return deepFreeze({
    schema_version: CONTRACT_SCHEMA_VERSION,
    kind: INTAKE_JOB_KIND,
    request_id: optionalString(payload.request_id, "payload.request_id"),
    submitted_at: optionalString(payload.submitted_at, "payload.submitted_at"),
    renderer_status: INTAKE_RENDERER_STATUSES.PENDING,
    product_id: requiredString(payload.product_id, "payload.product_id"),
    source_folder: requiredString(payload.source_folder, "payload.source_folder"),
    source_folder_origin: sourceFolderOrigin,
    run_label: normalizeRunLabel(requiredString(payload.run_label, "payload.run_label")),
    options: sanitizeIntakeOptions(payload.options),
    constraints: INTAKE_CONSTRAINTS
  });
}

export function sanitizeIntakeOptions(options = {}) {
  assertPlainObject(options, "options");
  assertAllowedKeys(options, INTAKE_OPTION_ALLOWED_KEYS, "options");
  assertNoSecretFields(options, "options");

  return deepFreeze({
    scene_threshold: boundedNumber(
      options.scene_threshold,
      INTAKE_DEFAULT_OPTIONS.scene_threshold,
      0.01,
      1
    ),
    candidate_min_duration_s: boundedNumber(
      options.candidate_min_duration_s,
      INTAKE_DEFAULT_OPTIONS.candidate_min_duration_s,
      0.1,
      60
    ),
    trim_story_units: booleanOption(
      options.trim_story_units,
      INTAKE_DEFAULT_OPTIONS.trim_story_units
    ),
    generate_physical_shots: booleanOption(
      options.generate_physical_shots,
      INTAKE_DEFAULT_OPTIONS.generate_physical_shots
    ),
    upload_for_video_embedding: booleanOption(
      options.upload_for_video_embedding,
      INTAKE_DEFAULT_OPTIONS.upload_for_video_embedding
    ),
    embedding_channels: sanitizeStringList(
      options.embedding_channels,
      INTAKE_DEFAULT_OPTIONS.embedding_channels,
      ALLOWED_EMBEDDING_CHANNELS,
      "options.embedding_channels"
    ),
    qa_checks: sanitizeStringList(
      options.qa_checks,
      INTAKE_DEFAULT_OPTIONS.qa_checks,
      ALLOWED_QA_CHECKS,
      "options.qa_checks"
    )
  });
}

export function mapWorkerStatusToRendererStatus(status) {
  const normalized = normalizeStatus(status);

  if (
    normalized === WORKER_JOB_STATUSES.CREATED ||
    normalized === WORKER_JOB_STATUSES.QUEUED ||
    normalized === INTAKE_RENDERER_STATUSES.PENDING
  ) {
    return INTAKE_RENDERER_STATUSES.PENDING;
  }

  if (normalized === WORKER_JOB_STATUSES.RUNNING) {
    return INTAKE_RENDERER_STATUSES.RUNNING;
  }

  if (
    normalized === WORKER_JOB_STATUSES.SUCCEEDED ||
    normalized === WORKER_JOB_STATUSES.WARNING
  ) {
    return INTAKE_RENDERER_STATUSES.SUCCEEDED;
  }

  if (
    normalized === WORKER_JOB_STATUSES.CANCELLED ||
    normalized === WORKER_JOB_STATUSES.CANCELED
  ) {
    return INTAKE_RENDERER_STATUSES.CANCELED;
  }

  return INTAKE_RENDERER_STATUSES.FAILED;
}

export function createIntakeJobRecord(requestPayload, context = {}) {
  const request = ensureIntakeJobRequest(requestPayload);
  assertPlainObject(context, "context");

  return deepFreeze({
    schema_version: CONTRACT_SCHEMA_VERSION,
    kind: "voah.worker_job.intake",
    job_id: optionalString(context.job_id, "context.job_id"),
    stage: INTAKE_STAGE,
    scope_type: "intake_run",
    scope_id: optionalString(context.intake_run_id, "context.intake_run_id"),
    product_id: request.product_id,
    status: INTAKE_RENDERER_STATUSES.PENDING,
    command_kind: "python",
    command_display: "voah-video-intake worker",
    dispatch_service: INTAKE_CONSTRAINTS.dispatch_service,
    runner_service: INTAKE_CONSTRAINTS.runner_service,
    artifact_service: INTAKE_CONSTRAINTS.artifact_registration_service,
    inputs: {
      product_id: request.product_id,
      source_folder: request.source_folder,
      run_label: request.run_label
    },
    options: request.options,
    source_request: request,
    constraints: INTAKE_CONSTRAINTS
  });
}

export function createIntakeWorkerInput(requestPayload, context) {
  const request = ensureIntakeJobRequest(requestPayload);
  assertPlainObject(context, "context");

  const jobId = requiredString(context.job_id, "context.job_id");
  const workspaceRoot = requiredString(context.workspace_root, "context.workspace_root");
  const cacheRoot = requiredString(context.cache_root, "context.cache_root");
  const intakeRunId = requiredString(context.intake_run_id, "context.intake_run_id");
  const runDir = requiredString(context.run_dir, "context.run_dir");
  const productSlug = optionalString(context.product_slug, "context.product_slug");
  const productName = optionalString(context.product_name, "context.product_name");

  return deepFreeze({
    schema_version: CONTRACT_SCHEMA_VERSION,
    job_id: jobId,
    stage: INTAKE_STAGE,
    workspace: {
      root: workspaceRoot,
      cache_root: cacheRoot
    },
    scope: {
      type: "intake_run",
      id: intakeRunId,
      dir: runDir
    },
    inputs: {
      product_id: request.product_id,
      product_slug: productSlug,
      product_name: productName,
      source_folder: request.source_folder,
      source_folder_origin: request.source_folder_origin,
      run_label: request.run_label
    },
    options: request.options,
    secret_refs: {
      required: ["dashscope"],
      values_visible_to_renderer: false,
      values_written_to_manifest: false
    },
    outputs: {
      expected: createIntakeExpectedOutputs(runDir)
    },
    constraints: INTAKE_CONSTRAINTS,
    next_consumers: [
      "ArtifactService.registerMany",
      "products:updateProductionReadiness"
    ]
  });
}

export function createIntakeExpectedOutputs(runDir) {
  const dir = requiredString(runDir, "runDir");

  return deepFreeze({
    intake_manifest: joinPath(dir, "run_manifest.json"),
    assets: joinPath(dir, "assets.json"),
    scene_segments_raw: joinPath(dir, "scene_segments_raw.json"),
    scene_segments_merged: joinPath(dir, "scene_segments_merged_1p2.json"),
    story_units: joinPath(dir, "story_units.json"),
    physical_shots: joinPath(dir, "physical_shots.json"),
    vectorization_inputs: joinPath(dir, "vectorization_inputs.json"),
    embedding_results: joinPath(dir, "embedding_results.json"),
    shot_index: joinPath(dir, "shot_index.json"),
    qa_report: joinPath(dir, "qa_last_frames.json")
  });
}

export function createIntakeArtifactRegistrationPlan(input) {
  assertPlainObject(input, "input");

  const productId = requiredString(input.product_id, "input.product_id");
  const intakeRunId = requiredString(input.intake_run_id, "input.intake_run_id");
  const producerJobId = optionalString(input.producer_job_id, "input.producer_job_id");
  const runDir = requiredString(input.run_dir, "input.run_dir");
  const qaStatus = optionalString(input.qa_status, "input.qa_status") || "unknown";
  const outputs = {
    ...createIntakeExpectedOutputs(runDir),
    ...(isPlainObject(input.outputs) ? input.outputs : {})
  };

  const artifactSpecs = [
    [INTAKE_ARTIFACT_KINDS.INTAKE_MANIFEST, outputs.intake_manifest],
    [INTAKE_ARTIFACT_KINDS.ASSETS, outputs.assets],
    [INTAKE_ARTIFACT_KINDS.SCENE_SEGMENTS_RAW, outputs.scene_segments_raw],
    [INTAKE_ARTIFACT_KINDS.SCENE_SEGMENTS_MERGED, outputs.scene_segments_merged],
    [INTAKE_ARTIFACT_KINDS.STORY_UNITS, outputs.story_units],
    [INTAKE_ARTIFACT_KINDS.PHYSICAL_SHOTS, outputs.physical_shots],
    [INTAKE_ARTIFACT_KINDS.VECTORIZATION_INPUTS, outputs.vectorization_inputs],
    [INTAKE_ARTIFACT_KINDS.EMBEDDING_RESULTS, outputs.embedding_results],
    [INTAKE_ARTIFACT_KINDS.SHOT_INDEX, outputs.shot_index],
    [INTAKE_ARTIFACT_KINDS.QA_REPORT, outputs.qa_report]
  ];

  return deepFreeze(
    artifactSpecs.map(([kind, path]) => ({
      schema_version: CONTRACT_SCHEMA_VERSION,
      scope_type: "intake_run",
      scope_id: intakeRunId,
      product_id: productId,
      stage: INTAKE_STAGE,
      kind,
      path: requiredString(path, `outputs.${kind}`),
      producer_job_id: producerJobId,
      qa_status: qaStatus
    }))
  );
}

export function buildIntakeRunDir({ cache_root, product_slug, timestamp, run_label }) {
  const root = requiredString(cache_root, "cache_root");
  const slug = normalizePathSegment(requiredString(product_slug, "product_slug"));
  const stamp = normalizePathSegment(requiredString(timestamp, "timestamp"));
  const label = normalizeRunLabel(requiredString(run_label, "run_label"));

  return joinPath(root, "voah_video_intake", slug, `${stamp}_${label}`);
}

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function ensureIntakeJobRequest(payload) {
  if (
    isPlainObject(payload) &&
    payload.kind === INTAKE_JOB_KIND &&
    payload.schema_version === CONTRACT_SCHEMA_VERSION
  ) {
    assertAllowedKeys(payload, CANONICAL_REQUEST_ALLOWED_KEYS, "payload");
    return createIntakeJobRequest({
      request_id: payload.request_id,
      submitted_at: payload.submitted_at,
      product_id: payload.product_id,
      source_folder: payload.source_folder,
      source_folder_origin: payload.source_folder_origin,
      run_label: payload.run_label,
      options: payload.options
    });
  }

  return createIntakeJobRequest(payload);
}

function normalizeRunLabel(value) {
  const normalized = normalizePathSegment(value);
  if (!normalized) {
    throw new TypeError("run_label cannot be empty after normalization");
  }
  return normalized;
}

function normalizePathSegment(value) {
  return String(value)
    .trim()
    .replace(/[\\/:\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function joinPath(...parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).length > 0)
    .map((part, index) => {
      const value = String(part);
      if (index === 0) {
        return value.replace(/\/+$/g, "");
      }
      return value.replace(/^\/+|\/+$/g, "");
    })
    .join("/");
}

function requiredString(value, path) {
  const result = optionalString(value, path);
  if (!result) {
    throw new TypeError(`${path} is required`);
  }
  return result;
}

function optionalString(value, path) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${path} must be a string`);
  }
  return value.trim();
}

function boundedNumber(value, fallback, min, max) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("option must be a finite number");
  }
  if (value < min || value > max) {
    throw new RangeError(`option must be between ${min} and ${max}`);
  }
  return value;
}

function booleanOption(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new TypeError("option must be boolean");
  }
  return value;
}

function sanitizeStringList(value, fallback, allowedValues, path) {
  const source = value === undefined || value === null ? fallback : value;
  if (!Array.isArray(source)) {
    throw new TypeError(`${path} must be an array`);
  }

  const output = [];
  for (const item of source) {
    const normalized = requiredString(item, `${path}[]`);
    if (!allowedValues.has(normalized)) {
      throw new TypeError(`${path} contains unsupported value: ${normalized}`);
    }
    if (!output.includes(normalized)) {
      output.push(normalized);
    }
  }

  return deepFreeze(output);
}

function assertPlainObject(value, name) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedKeys(value, allowedKeys, name) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${name}.${key} is not supported by this contract`);
    }
  }
}

function assertNoSecretFields(value, path) {
  for (const key of Object.keys(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_SECRET_KEY_PARTS.some((part) => normalizedKey.includes(part.replace("_", "")))) {
      throw new TypeError(`${path}.${key} must not be sent through renderer contracts`);
    }
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") {
    return value;
  }

  Object.freeze(value);
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) {
      deepFreeze(nested);
    }
  }
  return value;
}
