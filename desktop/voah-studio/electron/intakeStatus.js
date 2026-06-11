export const INTAKE_STALL_MS = 120000;

export function normalizeIntakeStatus({ ready, statusPayload, result, manifest }) {
  if (ready && manifest?.status !== "failed") return "ready";
  const raw = result?.status || statusPayload?.status || manifest?.status || "";
  if (["succeeded", "ready", "completed"].includes(raw)) return ready ? "ready" : "succeeded";
  if (raw === "failed" || result?.error || manifest?.error) return "failed";
  if (raw === "stalled") return "stalled";
  if (raw === "running" || raw === "queued") {
    if (isStalled(statusPayload?.updated_at)) return "stalled";
    return "running";
  }
  if (!ready && (statusPayload || result || manifest?.created_at)) {
    if (isStalled(statusPayload?.updated_at || manifest?.updated_at)) return "stalled";
    return "running";
  }
  return ready ? "ready" : "pending";
}

export function intakeStatusLabel(status) {
  return {
    ready: "完成",
    succeeded: "完成",
    running: "处理中",
    stalled: "需查看",
    failed: "失败",
    pending: "待处理"
  }[status] || "处理中";
}

export function isStalled(updatedAt) {
  const ts = Date.parse(normalizeDate(updatedAt));
  return Number.isFinite(ts) && Date.now() - ts > INTAKE_STALL_MS;
}

export function normalizeDate(value) {
  const text = String(value || "");
  if (/[+-]\d{4}$/.test(text)) return `${text.slice(0, -5)}${text.slice(-5, -2)}:${text.slice(-2)}`;
  return text;
}

export function elapsedSeconds(start, end) {
  const startMs = Date.parse(normalizeDate(start));
  const endMs = Date.parse(normalizeDate(end)) || Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, Math.round((endMs - startMs) / 1000));
}

export function summarizeIntakeRuns(runs) {
  return {
    running: runs.filter((run) => ["running", "stalled"].includes(run.status)).length,
    failed: runs.filter((run) => run.status === "failed").length,
    ready: runs.filter((run) => run.ready && !run.system).length,
    skipped: runs.reduce((sum, run) => sum + Number(run.incremental?.skipped_count || 0), 0)
  };
}

export function dedupeIntakeRuns(runs) {
  const items = Array.isArray(runs) ? runs : [];
  const realByJobId = new Map();
  const realByRunDir = new Map();
  const runsWithRealRunDir = new Set();

  for (const run of items) {
    if (isIntakeJobRun(run)) continue;
    const jobId = normalizeToken(run?.job_id);
    const runDir = normalizeRunDir(run?.run_dir);
    if (jobId && !realByJobId.has(jobId)) realByJobId.set(jobId, run);
    if (runDir && !realByRunDir.has(runDir)) realByRunDir.set(runDir, run);
    if (runDir) runsWithRealRunDir.add(runDir);
  }

  const hiddenJobs = new Set();
  for (const run of items) {
    if (!isIntakeJobRun(run)) continue;
    const jobId = normalizeToken(run?.job_id || run?.name);
    const pointedRunDir = normalizeRunDir(run?.run_dir);
    const preferred = (jobId && realByJobId.get(jobId)) || (pointedRunDir && realByRunDir.get(pointedRunDir));
    if (preferred || (pointedRunDir && runsWithRealRunDir.has(pointedRunDir))) hiddenJobs.add(run);
  }

  return items.filter((run) => !hiddenJobs.has(run));
}

function isIntakeJobRun(run) {
  return run?.source === "job" || Boolean(run?.job_dir);
}

function normalizeRunDir(value) {
  return String(value || "").replace(/\/+$/, "");
}

function normalizeToken(value) {
  return String(value || "").trim();
}
