import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dedupeIntakeRuns, normalizeIntakeStatus, summarizeIntakeRuns } from "../electron/intakeStatus.js";
import { isTaskAcknowledged, withTaskAcknowledgement } from "../electron/taskAcknowledgements.js";
import { listTaskRuns } from "../electron/taskRuns.js";

test("intake status prefers explicit failed result over missing shot index", () => {
  const status = normalizeIntakeStatus({
    ready: false,
    statusPayload: { status: "running", updated_at: new Date().toISOString() },
    result: { status: "failed", error: { message: "upload timeout" } },
    manifest: {}
  });
  assert.equal(status, "failed");
});

test("intake running status becomes stalled when heartbeat is old", () => {
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const status = normalizeIntakeStatus({
    ready: false,
    statusPayload: { status: "running", updated_at: old },
    result: null,
    manifest: {}
  });
  assert.equal(status, "stalled");
});

test("ready shot index stays ready unless manifest failed", () => {
  assert.equal(
    normalizeIntakeStatus({
      ready: true,
      statusPayload: { status: "running" },
      result: null,
      manifest: { status: "ready" }
    }),
    "ready"
  );
});

test("intake summary separates running, failed and ready runs", () => {
  const summary = summarizeIntakeRuns([
    { status: "running", ready: false, incremental: { skipped_count: 1 } },
    { status: "failed", ready: false, incremental: { skipped_count: 2 } },
    { status: "ready", ready: true, system: false },
    { status: "ready", ready: true, system: true }
  ]);
  assert.deepEqual(summary, { running: 1, failed: 1, ready: 1, skipped: 3 });
});

test("intake run dedupe hides job status after real run appears", () => {
  const real = {
    name: "20260611_studio_intake",
    source: "run",
    run_dir: "/tmp/cache/demo/20260611_studio_intake",
    job_id: "job-1",
    status: "running"
  };
  const job = {
    name: "job-1",
    source: "job",
    job_id: "job-1",
    job_dir: "/tmp/cache/demo/_jobs/job-1",
    run_dir: "/tmp/cache/demo/20260611_studio_intake",
    status: "running"
  };
  assert.deepEqual(dedupeIntakeRuns([job, real]), [real]);
});

test("intake run dedupe hides job status when it points at an existing run dir", () => {
  const real = {
    name: "20260611_studio_intake",
    source: "run",
    run_dir: "/tmp/cache/demo/20260611_studio_intake",
    job_id: "",
    status: "running"
  };
  const job = {
    name: "job-2",
    source: "job",
    job_id: "job-2",
    job_dir: "/tmp/cache/demo/_jobs/job-2",
    run_dir: "/tmp/cache/demo/20260611_studio_intake",
    status: "running"
  };
  assert.deepEqual(dedupeIntakeRuns([job, real]), [real]);
});

test("intake run dedupe keeps job status before real run exists", () => {
  const job = {
    name: "job-1",
    source: "job",
    job_id: "job-1",
    job_dir: "/tmp/cache/demo/_jobs/job-1",
    run_dir: "/tmp/cache/demo/_jobs/job-1",
    status: "running"
  };
  assert.deepEqual(dedupeIntakeRuns([job]), [job]);
});

test("task acknowledgement matches stable key aliases", () => {
  const task = {
    id: "intake:demo:job:job-1:failed:2026-06-11T00:00:00.000Z:failed",
    ack_key: "intake:demo:job:job-1:failed:2026-06-11T00:00:00.000Z:failed",
    ack_keys: [
      "intake:demo:job:job-1:failed:2026-06-11T00:00:00.000Z:failed",
      "intake:demo:run:/tmp/run:failed:2026-06-11T00:00:00.000Z:failed"
    ],
    kind: "intake",
    status: "failed"
  };
  const payload = withTaskAcknowledgement(null, task, "2026-06-11T00:00:00.000Z");
  assert.equal(isTaskAcknowledged({ ack_key: "intake:demo:run:/tmp/run:failed:2026-06-11T00:00:00.000Z:failed" }, payload), true);
  assert.equal(isTaskAcknowledged({ ack_key: "intake:demo:run:/tmp/run:failed:2026-06-11T00:05:00.000Z:failed" }, payload), false);
});

test("studio task runs summarize failed run history without scanning temporary outputs as final videos", async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "voah-studio-runs-"));
  const runDir = path.join(taskDir, ".runs", "run_demo");
  await mkdir(path.join(runDir, "outputs", "hyperframes_subtitle_burn"), { recursive: true });
  await mkdir(path.join(runDir, "logs"), { recursive: true });
  await writeFile(path.join(runDir, "outputs", "hyperframes_subtitle_burn", "final_subtitled.mp4"), "");
  await writeFile(path.join(runDir, "run_manifest.json"), JSON.stringify({
    schema_version: "voah.task_run_manifest.v1",
    run_id: "run_demo",
    run_dir: runDir,
    logs_dir: path.join(runDir, "logs"),
    from_stage: "render",
    status: "failed",
    started_at: "2026-06-11T10:00:00.000Z",
    updated_at: "2026-06-11T10:00:10.000Z",
    stages: {
      render: {
        status: "failed",
        updated_at: "2026-06-11T10:00:10.000Z",
        error_message: "moov atom not found"
      }
    }
  }, null, 2));

  const runs = await listTaskRuns(taskDir);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[0].failed_stage, "render");
  assert.equal(runs[0].can_continue, true);
  assert.match(runs[0].error_summary, /moov atom/);
});
