import { CONTRACT_SCHEMA_VERSION } from "../lib/jobContracts.js";

export const PRODUCTION_READINESS_KIND = "voah.production_readiness";
export const BATCH_PRODUCTION_PAYLOAD_KIND = "voah.batch_production_payload";

export const PRODUCTION_READINESS_STATUSES = Object.freeze({
  READY: "ready",
  NEEDS_CONFIRMATION: "needs_confirmation",
  BLOCKED: "blocked"
});

export const PRODUCTION_BLOCKING_CODES = Object.freeze({
  NO_PRODUCT: "no_product",
  NO_INTAKE_RUN: "no_intake_run",
  INTAKE_RUN_NOT_READY: "intake_run_not_ready",
  INTAKE_RUN_FAILED: "intake_run_failed",
  BLOCKING_QA_FAILURE: "blocking_qa_failure",
  ASSET_COUNT_TOO_LOW: "asset_count_too_low",
  STORY_UNIT_COUNT_TOO_LOW: "story_unit_count_too_low",
  PHYSICAL_SHOT_COUNT_TOO_LOW: "physical_shot_count_too_low",
  EMBEDDING_CHANNEL_COUNT_TOO_LOW: "embedding_channel_count_too_low",
  REQUIRED_ARTIFACT_MISSING: "required_artifact_missing"
});

export const PRODUCTION_WARNING_CODES = Object.freeze({
  INTAKE_RUN_HAS_WARNING: "intake_run_has_warning",
  QA_STATUS_UNKNOWN: "qa_status_unknown",
  QA_WARNING: "qa_warning",
  PRODUCT_CLAIMS_EMPTY: "product_claims_empty",
  COUNT_MISSING: "count_missing",
  OPTIONAL_ARTIFACT_MISSING: "optional_artifact_missing"
});

export const DEFAULT_PRODUCTION_REQUIREMENTS = Object.freeze({
  min_asset_count: 1,
  min_story_unit_count: 1,
  min_physical_shot_count: 1,
  min_embedding_channel_count: 1,
  required_artifact_kinds: Object.freeze([
    "intake_manifest",
    "story_units",
    "physical_shots",
    "embedding_results"
  ]),
  optional_artifact_kinds: Object.freeze(["shot_index", "qa_report"])
});

const READY_RUN_STATUSES = new Set(["ready", "warning", "succeeded"]);
const WARNING_RUN_STATUSES = new Set(["warning"]);
const FAILED_RUN_STATUSES = new Set(["failed", "error", "blocked", "blocking_failure"]);
const NOT_READY_RUN_STATUSES = new Set([
  "draft",
  "created",
  "queued",
  "pending",
  "probing",
  "segmenting",
  "understanding",
  "embedding",
  "qa",
  "running",
  "cancelled",
  "canceled",
  "stale",
  "archived"
]);
const BLOCKING_QA_STATUSES = new Set(["failed", "blocking", "blocking_failure", "error"]);
const WARNING_QA_STATUSES = new Set(["warning", "warn", "needs_review"]);
const OK_QA_STATUSES = new Set(["ok", "ready", "passed", "succeeded"]);

export function deriveProductionReadiness(input, requirementOverrides = {}) {
  const source = normalizeReadinessInput(input);
  const requirements = {
    ...DEFAULT_PRODUCTION_REQUIREMENTS,
    ...requirementOverrides
  };

  const product = source.product;
  const productId = optionalString(product?.id || source.product_id);
  const productClaims = sanitizeProductClaims(source.product_claims);
  const latestRun = selectLatestIntakeRun(source.intake_runs, {
    latest_intake_run_id: source.latest_intake_run_id || product?.latest_intake_run_id
  });
  const blocking_reasons = [];
  const warnings = [];

  if (!productId) {
    blocking_reasons.push(createReason(PRODUCTION_BLOCKING_CODES.NO_PRODUCT));
  }

  if (!latestRun) {
    blocking_reasons.push(createReason(PRODUCTION_BLOCKING_CODES.NO_INTAKE_RUN));
  } else {
    collectRunReadinessSignals({
      run: latestRun,
      requirements,
      blocking_reasons,
      warnings
    });
  }

  if (productClaims.length === 0) {
    warnings.push(createReason(PRODUCTION_WARNING_CODES.PRODUCT_CLAIMS_EMPTY));
  }

  const status =
    blocking_reasons.length > 0
      ? PRODUCTION_READINESS_STATUSES.BLOCKED
      : warnings.length > 0
        ? PRODUCTION_READINESS_STATUSES.NEEDS_CONFIRMATION
        : PRODUCTION_READINESS_STATUSES.READY;

  return deepFreeze({
    schema_version: CONTRACT_SCHEMA_VERSION,
    kind: PRODUCTION_READINESS_KIND,
    product_id: productId,
    product_name: optionalString(product?.name),
    latest_intake_run_id: optionalString(latestRun?.id),
    latest_intake_run: latestRun ? summarizeIntakeRun(latestRun) : null,
    product_claims: productClaims,
    status,
    can_enter_production: status !== PRODUCTION_READINESS_STATUSES.BLOCKED,
    requires_warning_confirmation: status === PRODUCTION_READINESS_STATUSES.NEEDS_CONFIRMATION,
    blocking_reasons,
    warnings,
    requirements
  });
}

export function buildBatchProductionPayload(readinessOrInput, options = {}) {
  const readiness =
    isReadiness(readinessOrInput)
      ? readinessOrInput
      : deriveProductionReadiness(readinessOrInput, options.requirements);

  const confirmedWarningCodes = new Set(options.confirmed_warning_codes || []);
  const warningsConfirmed =
    options.confirm_warnings === true ||
    readiness.warnings.every((warning) => confirmedWarningCodes.has(warning.code));

  if (!readiness.can_enter_production) {
    throw new Error("production readiness is blocked");
  }

  if (readiness.requires_warning_confirmation && !warningsConfirmed) {
    throw new Error("production warnings must be confirmed before batch production");
  }

  return deepFreeze({
    schema_version: CONTRACT_SCHEMA_VERSION,
    kind: BATCH_PRODUCTION_PAYLOAD_KIND,
    product_id: readiness.product_id,
    latest_intake_run_id: readiness.latest_intake_run_id,
    product_claims: readiness.product_claims,
    readiness: {
      status: readiness.status,
      confirmed_warnings: readiness.requires_warning_confirmation
        ? readiness.warnings.map((warning) => warning.code)
        : [],
      blocking_reasons: readiness.blocking_reasons,
      warnings: readiness.warnings
    },
    task_defaults: sanitizeTaskDefaults(options.task_defaults),
    source: {
      module: "material_library",
      reused_by: ["home_batch_launcher", "task_create"]
    }
  });
}

export function buildHomepageProductionState(input, requirementOverrides = {}) {
  const products = Array.isArray(input?.products) ? input.products : [];
  const intakeRunsByProduct = input?.intake_runs_by_product || {};
  const productClaimsByProduct = input?.product_claims_by_product || {};

  const items = products.map((product) => {
    const productId = optionalString(product.id);
    return deriveProductionReadiness(
      {
        product,
        product_claims: productClaimsByProduct[productId] || product.product_claims || product.claims || [],
        intake_runs: intakeRunsByProduct[productId] || product.intake_runs || [],
        latest_intake_run_id: product.latest_intake_run_id
      },
      requirementOverrides
    );
  });

  return deepFreeze({
    schema_version: CONTRACT_SCHEMA_VERSION,
    kind: "voah.homepage.production_state",
    items,
    ready_product_ids: items
      .filter((item) => item.status === PRODUCTION_READINESS_STATUSES.READY)
      .map((item) => item.product_id),
    needs_confirmation_product_ids: items
      .filter((item) => item.status === PRODUCTION_READINESS_STATUSES.NEEDS_CONFIRMATION)
      .map((item) => item.product_id),
    blocked_product_ids: items
      .filter((item) => item.status === PRODUCTION_READINESS_STATUSES.BLOCKED)
      .map((item) => item.product_id)
  });
}

export function canEnterBatchProduction(readiness, options = {}) {
  if (!isReadiness(readiness) || !readiness.can_enter_production) {
    return false;
  }

  if (!readiness.requires_warning_confirmation) {
    return true;
  }

  const confirmedWarningCodes = new Set(options.confirmed_warning_codes || []);
  return (
    options.confirm_warnings === true ||
    readiness.warnings.every((warning) => confirmedWarningCodes.has(warning.code))
  );
}

function collectRunReadinessSignals({ run, requirements, blocking_reasons, warnings }) {
  const runStatus = normalizeStatus(run.status);
  const qaStatus = normalizeStatus(run.qa_status || run.qa?.status);

  if (FAILED_RUN_STATUSES.has(runStatus)) {
    blocking_reasons.push(createReason(PRODUCTION_BLOCKING_CODES.INTAKE_RUN_FAILED, { run_id: run.id }));
  } else if (!READY_RUN_STATUSES.has(runStatus)) {
    const code = NOT_READY_RUN_STATUSES.has(runStatus)
      ? PRODUCTION_BLOCKING_CODES.INTAKE_RUN_NOT_READY
      : PRODUCTION_BLOCKING_CODES.INTAKE_RUN_NOT_READY;
    blocking_reasons.push(createReason(code, { run_id: run.id, status: runStatus || "unknown" }));
  }

  if (WARNING_RUN_STATUSES.has(runStatus)) {
    warnings.push(createReason(PRODUCTION_WARNING_CODES.INTAKE_RUN_HAS_WARNING, { run_id: run.id }));
  }

  if (BLOCKING_QA_STATUSES.has(qaStatus)) {
    blocking_reasons.push(createReason(PRODUCTION_BLOCKING_CODES.BLOCKING_QA_FAILURE, { run_id: run.id }));
  } else if (WARNING_QA_STATUSES.has(qaStatus)) {
    warnings.push(createReason(PRODUCTION_WARNING_CODES.QA_WARNING, { run_id: run.id }));
  } else if (!OK_QA_STATUSES.has(qaStatus)) {
    warnings.push(createReason(PRODUCTION_WARNING_CODES.QA_STATUS_UNKNOWN, { run_id: run.id }));
  }

  appendBlockingFailures(run, blocking_reasons);
  appendWarningSignals(run, warnings);
  checkMinimumCount(run, "asset_count", requirements.min_asset_count, PRODUCTION_BLOCKING_CODES.ASSET_COUNT_TOO_LOW, blocking_reasons, warnings);
  checkMinimumCount(run, "story_unit_count", requirements.min_story_unit_count, PRODUCTION_BLOCKING_CODES.STORY_UNIT_COUNT_TOO_LOW, blocking_reasons, warnings);
  checkMinimumCount(run, "physical_shot_count", requirements.min_physical_shot_count, PRODUCTION_BLOCKING_CODES.PHYSICAL_SHOT_COUNT_TOO_LOW, blocking_reasons, warnings);
  checkMinimumCount(run, "embedding_channel_count", requirements.min_embedding_channel_count, PRODUCTION_BLOCKING_CODES.EMBEDDING_CHANNEL_COUNT_TOO_LOW, blocking_reasons, warnings);
  checkArtifacts(run, requirements, blocking_reasons, warnings);
}

function appendBlockingFailures(run, blocking_reasons) {
  const failures = [
    ...arrayFrom(run.blocking_failures),
    ...arrayFrom(run.qa?.blocking_failures)
  ];

  for (const failure of failures) {
    blocking_reasons.push(
      createReason(PRODUCTION_BLOCKING_CODES.BLOCKING_QA_FAILURE, {
        run_id: run.id,
        detail: String(failure)
      })
    );
  }
}

function appendWarningSignals(run, warnings) {
  const warningItems = [
    ...arrayFrom(run.warnings),
    ...arrayFrom(run.qa_warnings),
    ...arrayFrom(run.qa?.warnings)
  ];

  for (const warning of warningItems) {
    warnings.push(
      createReason(PRODUCTION_WARNING_CODES.QA_WARNING, {
        run_id: run.id,
        detail: String(warning)
      })
    );
  }
}

function checkMinimumCount(run, field, minimum, code, blocking_reasons, warnings) {
  const value = run[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(createReason(PRODUCTION_WARNING_CODES.COUNT_MISSING, { field, run_id: run.id }));
    return;
  }

  if (value < minimum) {
    blocking_reasons.push(createReason(code, { field, minimum, actual: value, run_id: run.id }));
  }
}

function checkArtifacts(run, requirements, blocking_reasons, warnings) {
  const availableKinds = getArtifactKinds(run);

  if (availableKinds.size === 0) {
    for (const kind of requirements.required_artifact_kinds || []) {
      blocking_reasons.push(createReason(PRODUCTION_BLOCKING_CODES.REQUIRED_ARTIFACT_MISSING, { kind, run_id: run.id }));
    }
    warnings.push(createReason(PRODUCTION_WARNING_CODES.OPTIONAL_ARTIFACT_MISSING, { detail: "artifact_index_missing", run_id: run.id }));
    return;
  }

  for (const kind of requirements.required_artifact_kinds || []) {
    if (!availableKinds.has(kind)) {
      blocking_reasons.push(createReason(PRODUCTION_BLOCKING_CODES.REQUIRED_ARTIFACT_MISSING, { kind, run_id: run.id }));
    }
  }

  for (const kind of requirements.optional_artifact_kinds || []) {
    if (!availableKinds.has(kind)) {
      warnings.push(createReason(PRODUCTION_WARNING_CODES.OPTIONAL_ARTIFACT_MISSING, { kind, run_id: run.id }));
    }
  }
}

function getArtifactKinds(run) {
  const kinds = new Set();

  if (Array.isArray(run.artifacts)) {
    for (const artifact of run.artifacts) {
      if (typeof artifact === "string") {
        addArtifactKind(kinds, artifact);
      } else if (artifact?.kind) {
        addArtifactKind(kinds, artifact.kind);
      }
    }
  } else if (isPlainObject(run.artifacts)) {
    for (const [kind, artifact] of Object.entries(run.artifacts)) {
      if (artifact?.available !== false) {
        addArtifactKind(kinds, artifact?.kind || kind);
      }
    }
  }

  if (isPlainObject(run.artifact_paths)) {
    for (const key of Object.keys(run.artifact_paths)) {
      addArtifactKind(kinds, key);
    }
  }

  return kinds;
}

function addArtifactKind(kinds, kind) {
  const normalized = optionalString(kind);
  if (!normalized) {
    return;
  }

  kinds.add(normalized);

  const aliases = {
    run_manifest: "intake_manifest",
    manifest: "intake_manifest",
    qa_last_frames: "qa_report"
  };

  if (aliases[normalized]) {
    kinds.add(aliases[normalized]);
  }
}

function selectLatestIntakeRun(runs, options = {}) {
  const normalizedRuns = arrayFrom(runs).filter(isPlainObject);
  if (normalizedRuns.length === 0) {
    return null;
  }

  const explicitId = optionalString(options.latest_intake_run_id);
  if (explicitId) {
    const explicitRun = normalizedRuns.find((run) => optionalString(run.id) === explicitId);
    if (explicitRun) {
      return explicitRun;
    }
  }

  return [...normalizedRuns].sort(compareRunsNewestFirst)[0];
}

function compareRunsNewestFirst(a, b) {
  const aTime = getRunSortTime(a);
  const bTime = getRunSortTime(b);

  if (aTime !== bTime) {
    return bTime - aTime;
  }

  return String(b.id || "").localeCompare(String(a.id || ""));
}

function getRunSortTime(run) {
  const value = run.finished_at || run.started_at || run.updated_at || run.created_at || "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function summarizeIntakeRun(run) {
  return deepFreeze({
    id: optionalString(run.id),
    run_label: optionalString(run.run_label),
    run_dir: optionalString(run.run_dir),
    status: optionalString(run.status),
    qa_status: optionalString(run.qa_status || run.qa?.status),
    asset_count: numericOrNull(run.asset_count),
    story_unit_count: numericOrNull(run.story_unit_count),
    physical_shot_count: numericOrNull(run.physical_shot_count),
    embedding_channel_count: numericOrNull(run.embedding_channel_count),
    manifest_path: optionalString(run.manifest_path),
    created_at: optionalString(run.created_at),
    finished_at: optionalString(run.finished_at)
  });
}

function sanitizeProductClaims(claims) {
  return deepFreeze(
    arrayFrom(claims)
      .filter(isPlainObject)
      .map((claim) => ({
        id: optionalString(claim.id),
        product_id: optionalString(claim.product_id),
        claim_type: optionalString(claim.claim_type || claim.type),
        title: optionalString(claim.title),
        body: optionalString(claim.body),
        priority: numericOrNull(claim.priority),
        valid_from: optionalString(claim.valid_from),
        valid_to: optionalString(claim.valid_to)
      }))
  );
}

function sanitizeTaskDefaults(defaults = {}) {
  if (!isPlainObject(defaults)) {
    return deepFreeze({});
  }

  return deepFreeze({
    platform: optionalString(defaults.platform),
    objective: optionalString(defaults.objective),
    target_count: numericOrNull(defaults.target_count),
    target_duration_min_s: numericOrNull(defaults.target_duration_min_s),
    target_duration_max_s: numericOrNull(defaults.target_duration_max_s),
    production_preset_id: optionalString(defaults.production_preset_id)
  });
}

function normalizeReadinessInput(input) {
  if (!isPlainObject(input)) {
    return {
      product: null,
      product_claims: [],
      intake_runs: [],
      latest_intake_run_id: null
    };
  }

  return {
    product: input.product || null,
    product_id: input.product_id,
    product_claims: input.product_claims || input.product?.product_claims || input.product?.claims || [],
    intake_runs: input.intake_runs || input.product?.intake_runs || [],
    latest_intake_run_id: input.latest_intake_run_id || input.product?.latest_intake_run_id
  };
}

function isReadiness(value) {
  return isPlainObject(value) && value.kind === PRODUCTION_READINESS_KIND;
}

function createReason(code, details = {}) {
  return deepFreeze({
    code,
    ...details
  });
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function optionalString(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return String(value).trim();
  }
  return value.trim();
}

function numericOrNull(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function arrayFrom(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
