import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIntakeStatus, summarizeIntakeRuns } from "../electron/intakeStatus.js";

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
