import { hasRendererUnsafeFields } from "../src/lib/intakeSummary.js";
import { scanIntakeRunSummaries } from "../src/lib/intakeSummaryNode.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runIntakeDryRunJob } from "../electron/services/workerRunner.js";
import {
  createIntakeArtifactRegistrationPlan,
  createIntakeJobRecord,
  createIntakeJobRequest,
  createIntakeWorkerInput
} from "../src/lib/jobContracts.js";
import {
  activeProductCopyContext,
  activeProductProfile,
  intakeRunSummaries
} from "../src/data/libraryData.js";
import {
  buildBatchProductionPayload,
  deriveProductionReadiness
} from "../src/data/productionReadiness.js";

const workspaceRoot = process.argv[2] || process.cwd().replace(/\/desktop\/voah-app$/u, "");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const scannedRuns = await scanIntakeRunSummaries({
  workspaceRoot,
  productSlug: "fangshai-qidian"
});
const latestRun = scannedRuns.find((run) =>
  run.run_label === "20260603_225800_merged5_scene_candidates_v1"
);

assert(scannedRuns.length > 0, "expected at least one fangshai-qidian intake run");
assert(latestRun, "expected merged5 scene candidate run");
assert(latestRun.asset_count === 5, "asset_count should be 5");
assert(latestRun.story_unit_count > 0, "story_unit_count should be present");
assert(latestRun.physical_shot_count > 0, "physical_shot_count should be present");
assert(latestRun.embedding_channel_count > 0, "embedding_channel_count should be present");
assert(latestRun.qa_status, "qa_status should be present");
assert(!hasRendererUnsafeFields(latestRun), "renderer summary must not expose unsafe fields");

const claimTypes = new Set(activeProductProfile.claims.map((claim) => claim.claim_type));
for (const type of ["selling_point", "offer", "cta", "forbidden"]) {
  assert(claimTypes.has(type), `missing claim type: ${type}`);
}
assert(
  activeProductCopyContext.task_context_contract.not_kpi_fields.includes("selling_point_top"),
  "selling point top must be copy input, not KPI"
);

const request = createIntakeJobRequest({
  product_id: activeProductProfile.id,
  source_folder: activeProductProfile.source_folder,
  source_folder_origin: "user_selected",
  run_label: "desktop_contract_verify"
});
assert(request.renderer_status === "pending", "intake request should start pending");

let secretRejected = false;
try {
  createIntakeJobRequest({
    product_id: "x",
    source_folder: "y",
    source_folder_origin: "user_selected",
    run_label: "z",
    api_key: "should-not-pass"
  });
} catch {
  secretRejected = true;
}
assert(secretRejected, "renderer intake request must reject secret fields");

const job = createIntakeJobRecord(request, {
  job_id: "job_contract_verify",
  intake_run_id: "run_contract_verify"
});
const workerInput = createIntakeWorkerInput(request, {
  job_id: job.job_id,
  workspace_root: workspaceRoot,
  cache_root: `${workspaceRoot}/cache`,
  intake_run_id: job.scope_id,
  run_dir: "cache/voah_video_intake/fangshai-qidian/contract_verify",
  product_slug: "fangshai-qidian",
  product_name: activeProductProfile.name
});
const artifactPlan = createIntakeArtifactRegistrationPlan({
  product_id: request.product_id,
  intake_run_id: job.scope_id,
  producer_job_id: job.job_id,
  run_dir: workerInput.scope.dir,
  qa_status: "unknown"
});
assert(workerInput.secret_refs.values_visible_to_renderer === false, "secret values must not be renderer visible");
assert(workerInput.secret_refs.values_written_to_manifest === false, "secret values must not be written to manifest");
assert(artifactPlan.length >= 5, "artifact registration plan should include intake artifacts");

const dryRunDir = await mkdtemp(path.join(tmpdir(), "voah-intake-dry-run-"));
const dryRunResult = await runIntakeDryRunJob({
  appDataDir: dryRunDir,
  request,
  job,
  workspaceRoot,
  cacheRoot: `${workspaceRoot}/cache`
});
assert(dryRunResult.status === "succeeded", "dry-run worker should succeed");
assert(dryRunResult.worker_manifest.status === "succeeded", "worker manifest should succeed");
assert(dryRunResult.artifact_plan.length >= 5, "dry-run should emit artifact registration plan");
assert(dryRunResult.logs.stdout && dryRunResult.logs.stderr, "dry-run should expose log paths");

const readiness = deriveProductionReadiness({
  product: activeProductProfile,
  product_claims: activeProductProfile.claims,
  intake_runs: intakeRunSummaries
});
assert(readiness.can_enter_production, "fangshai-qidian should be eligible for production with confirmation");
const payload = buildBatchProductionPayload(readiness, {
  confirm_warnings: true,
  task_defaults: {
    platform: "douyin",
    objective: "带货短视频混剪",
    target_count: 200
  }
});
assert(payload.product_id === activeProductProfile.id, "payload should carry product_id");
assert(payload.latest_intake_run_id, "payload should carry latest_intake_run_id");
assert(payload.product_claims.length > 0, "payload should carry product_claims");

console.log(JSON.stringify({
  ok: true,
  scanned_runs: scannedRuns.length,
  latest_run: latestRun.run_label,
  issue_2_counts: {
    asset_count: latestRun.asset_count,
    story_unit_count: latestRun.story_unit_count,
    physical_shot_count: latestRun.physical_shot_count,
    embedding_channel_count: latestRun.embedding_channel_count,
    qa_status: latestRun.qa_status
  },
  issue_4_job_status: job.status,
  issue_4_dry_run_status: dryRunResult.status,
  issue_7_readiness: readiness.status
}, null, 2));
