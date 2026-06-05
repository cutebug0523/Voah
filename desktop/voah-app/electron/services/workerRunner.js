import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  createIntakeArtifactRegistrationPlan,
  createIntakeWorkerInput
} from "../../src/lib/jobContracts.js";

export async function runIntakeDryRunJob({ appDataDir, request, job, workspaceRoot, cacheRoot }) {
  const runDir = path.join(appDataDir, "dry-runs", job.scope_id.replace(/[^a-zA-Z0-9_-]/g, "_"));
  const jobDir = path.join(appDataDir, "jobs", job.job_id);
  const inputPath = path.join(jobDir, "worker_input.json");
  const workerManifestPath = path.join(jobDir, "worker_manifest.json");
  const artifactRegistryPath = path.join(jobDir, "artifact_registration_plan.json");
  const stdoutPath = path.join(jobDir, "stdout.log");
  const stderrPath = path.join(jobDir, "stderr.log");
  await mkdir(jobDir, { recursive: true });

  const workerInput = createIntakeWorkerInput(request, {
    job_id: job.job_id,
    workspace_root: workspaceRoot,
    cache_root: cacheRoot,
    intake_run_id: job.scope_id,
    run_dir: runDir,
    product_slug: request.product_id.replace(/^product_/, "").replaceAll("_", "-"),
    product_name: request.product_id
  });
  await writeFile(inputPath, JSON.stringify(workerInput, null, 2) + "\n", "utf8");

  const workerPath = path.resolve("workers", "intake_dry_run.py");
  const result = await runProcess({
    command: "python3",
    args: [workerPath, "--input", inputPath, "--out", workerManifestPath]
  });
  await writeFile(stdoutPath, result.stdout, "utf8");
  await writeFile(stderrPath, result.stderr, "utf8");

  if (result.exitCode !== 0) {
    return {
      status: "failed",
      worker_input: workerInput,
      logs: { stdout: stdoutPath, stderr: stderrPath },
      error: result.stderr || `worker exited with ${result.exitCode}`
    };
  }

  const workerManifest = JSON.parse(await readFile(workerManifestPath, "utf8"));
  const artifact_plan = createIntakeArtifactRegistrationPlan({
    product_id: request.product_id,
    intake_run_id: job.scope_id,
    producer_job_id: job.job_id,
    run_dir: workerManifest.outputs.run_dir,
    qa_status: workerManifest.qa.status
  });
  await writeFile(artifactRegistryPath, JSON.stringify(artifact_plan, null, 2) + "\n", "utf8");

  return {
    status: "succeeded",
    worker_input: workerInput,
    worker_manifest: workerManifest,
    artifact_plan,
    artifact_registry_path: artifactRegistryPath,
    logs: { stdout: stdoutPath, stderr: stderrPath }
  };
}

function runProcess({ command, args }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: path.resolve("."),
      env: process.env
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}
