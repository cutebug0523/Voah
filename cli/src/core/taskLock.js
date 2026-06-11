import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { UserError } from "./errors.js";

const LOCK_DIR_NAME = ".voah_task.lock";
const LOCK_FILE_NAME = "run.json";
const LOCK_GRACE_MS = 30 * 1000;
const LOCK_STALE_MS = 12 * 60 * 60 * 1000;

export async function withTaskRunLock(taskDir, metadata, fn) {
  const lock = await acquireTaskRunLock(taskDir, metadata);
  try {
    return await fn();
  } finally {
    await releaseTaskRunLock(lock);
  }
}

export async function acquireTaskRunLock(taskDir, metadata = {}) {
  if (!taskDir) throw new UserError("缺少 task_dir，无法创建运行锁");
  const lockDir = path.join(taskDir, LOCK_DIR_NAME);
  const lockFile = path.join(lockDir, LOCK_FILE_NAME);
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const payload = {
    schema_version: "voah.task_lock.v1",
    token,
    pid: process.pid,
    task_dir: taskDir,
    from: metadata.from || "",
    stage: metadata.stage || "",
    scope: metadata.scope || "",
    command: process.argv.join(" "),
    acquired_at: new Date().toISOString()
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(lockDir);
      await writeFile(lockFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      return { lockDir, lockFile, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await inspectTaskRunLock(lockDir, lockFile);
      if (existing.active) {
        throw new UserError(activeLockMessage(existing, lockDir));
      }
      await rm(lockDir, { recursive: true, force: true });
    }
  }
  throw new UserError(`任务运行锁暂时无法获取：${lockDir}`);
}

export async function releaseTaskRunLock(lock) {
  if (!lock?.lockDir) return;
  try {
    const payload = JSON.parse(await readFile(lock.lockFile, "utf8"));
    if (payload?.token && payload.token !== lock.token) return;
  } catch {
    return;
  }
  await rm(lock.lockDir, { recursive: true, force: true });
}

async function inspectTaskRunLock(lockDir, lockFile) {
  const lockStat = await stat(lockDir).catch(() => null);
  const payload = await readLockPayload(lockFile);
  const acquiredAt = payload?.acquired_at ? Date.parse(payload.acquired_at) : NaN;
  const stampMs = Number.isFinite(acquiredAt) ? acquiredAt : lockStat?.mtimeMs || Date.now();
  const ageMs = Math.max(0, Date.now() - stampMs);
  const pid = Number(payload?.pid || 0);
  const pidAlive = pid > 0 ? isPidAlive(pid) : false;
  const active = ageMs < LOCK_GRACE_MS || (pidAlive && ageMs < LOCK_STALE_MS);
  return { payload, ageMs, pid, pidAlive, active };
}

async function readLockPayload(lockFile) {
  try {
    return JSON.parse(await readFile(lockFile, "utf8"));
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function activeLockMessage(existing, lockDir) {
  const payload = existing.payload || {};
  const target = payload.stage || payload.from || payload.scope || "task";
  const started = payload.acquired_at || "";
  const pid = payload.pid || "";
  return [
    "任务正在运行，已拒绝重复启动。",
    pid ? `pid=${pid}` : "",
    target ? `stage=${target}` : "",
    started ? `started_at=${started}` : "",
    `lock=${lockDir}`
  ].filter(Boolean).join(" ");
}
