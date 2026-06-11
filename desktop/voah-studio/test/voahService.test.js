import test from "node:test";
import assert from "node:assert/strict";
import { dedupeIntakeRuns, normalizeIntakeStatus, summarizeIntakeRuns } from "../electron/intakeStatus.js";
import { isTaskAcknowledged, withTaskAcknowledgement } from "../electron/taskAcknowledgements.js";

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
