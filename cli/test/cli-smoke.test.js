import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { acquireTaskRunLock, releaseTaskRunLock } from "../src/core/taskLock.js";
import { resolveRetrievalDiversityStatePath, retrieveMinClipDuration } from "../src/core/taskPipeline.js";

const CLI = fileURLToPath(new URL("../src/bin/voah.js", import.meta.url));

function run(args, options = {}) {
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], options, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr, code: error?.code || 0 });
    });
  });
}

function runWithInput(args, input, options = {}) {
  return new Promise((resolve) => {
    const child = execFile("node", [CLI, ...args], options, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr, code: error?.code || 0 });
    });
    child.stdin.end(input);
  });
}

async function writeQaFakeBin(workspace, { failOnOmni = false } = {}) {
  const binDir = path.join(workspace, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    path.join(binDir, "python3"),
    `#!/bin/sh
case "$1" in
  *voah_omni_alignment_qa.py)
    ${failOnOmni ? "echo omni-called > \"$VOAH_FAKE_OMNI_MARKER\"; exit 9" : ""}
    OUT=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--output-dir" ]; then shift; OUT="$1"; fi
      shift
    done
    mkdir -p "$OUT"
    echo '{"qa":{"status":"ok"},"summary":{"section_count":1,"pass_count":1,"fail_count":0}}' > "$OUT/omni_alignment_results.json"
    echo omni-called > "$VOAH_FAKE_OMNI_MARKER"
    ;;
  *voah_write_full_pipeline_manifest.py)
    TASK=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--task-dir" ]; then shift; TASK="$1"; fi
      shift
    done
    echo '{"qa":{"status":"ok"}}' > "$TASK/full_pipeline_manifest.json"
    ;;
  *voah_build_desktop_quality_report.py)
    TASK=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--task-dir" ]; then shift; TASK="$1"; fi
      shift
    done
    echo '{"qa":{"status":"ok"}}' > "$TASK/desktop_quality_report.json"
    echo '# report' > "$TASK/desktop_quality_report.md"
    ;;
  *)
    exit 1
    ;;
esac
`,
    { mode: 0o755 }
  );
  return binDir;
}

test("voah help prints stable commands", async () => {
  const result = await run(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /voah task run/);
  assert.match(result.stdout, /voah batch run/);
});

test("task create writes task_manifest and task_brief without running models", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-test-"));
  const intakeRun = path.join(workspace, "cache", "voah_video_intake", "demo", "run");
  const productDir = path.join(workspace, "data", "products", "demo");
  await mkdir(intakeRun, { recursive: true });
  await mkdir(productDir, { recursive: true });
  await writeFile(path.join(intakeRun, "shot_index.json"), JSON.stringify({ records: [] }));
  await writeFile(path.join(productDir, "product.json"), JSON.stringify({ name: "Demo", brand: "DemoBrand", category: "防晒气垫", cta: "点击下单" }));
  await writeFile(path.join(productDir, "claims.json"), JSON.stringify({ claims: [{ text: "服帖自然" }] }));
  await writeFile(path.join(productDir, "campaigns.json"), JSON.stringify({ campaigns: [{ text: "直播间限时福利" }] }));
  await writeFile(path.join(productDir, "blocked_terms.json"), JSON.stringify({ terms: [{ text: "最强" }] }));
  const result = await run([
    "task",
    "create",
    "--workspace",
    workspace,
    "--product",
    "demo",
    "--product-name",
    "Demo",
    "--intake-run",
    intakeRun,
    "--target-duration",
    "45",
    "--label",
    "smoke",
    "--speed",
    "1.25",
    "--vol",
    "0.9",
    "--pitch",
    "2",
    "--emotion",
    "calm",
    "--modify-pitch",
    "18",
    "--modify-intensity",
    "21",
    "--modify-timbre",
    "-3",
    "--subtitle-preset",
    "live_bar_lower",
    "--font-source",
    "/tmp/VoahFont.ttf",
    "--resolution",
    "1080p"
  ]);
  assert.equal(result.code, 0, result.stderr);
  const taskDir = result.stdout.match(/task_dir=(.*)/)?.[1].trim();
  assert.ok(taskDir);
  assert.ok(existsSync(path.join(taskDir, "task_manifest.json")));
  assert.ok(existsSync(path.join(taskDir, "task_brief.json")));
  const manifest = JSON.parse(await readFile(path.join(taskDir, "task_manifest.json"), "utf8"));
  assert.equal(manifest.product_slug, "demo");
  assert.equal(manifest.active_artifacts.task_brief, "task_brief.json");
  assert.equal(manifest.tts.speed, 1.25);
  assert.equal(manifest.tts.vol, 0.9);
  assert.equal(manifest.tts.pitch, 2);
  assert.equal(manifest.tts.emotion, "calm");
  assert.equal(manifest.tts.modify_pitch, 18);
  assert.equal(manifest.tts.voice_modify.intensity, 21);
  assert.equal(manifest.tts.voice_modify.timbre, -3);
  assert.equal(manifest.subtitle.preset, "live_bar_lower");
  assert.equal(manifest.subtitle.font_source, "/tmp/VoahFont.ttf");
  assert.equal(manifest.resolution, "1080p");
  assert.deepEqual(manifest.canvas, { preset: "1080p", width: 1080, height: 1920, fps: 30 });
  const brief = JSON.parse(await readFile(path.join(taskDir, "task_brief.json"), "utf8"));
  assert.deepEqual(brief.product_claims, [{ text: "服帖自然" }]);
  assert.deepEqual(brief.product_campaigns, [{ text: "直播间限时福利" }]);
  assert.deepEqual(brief.product_blocked_terms, [{ text: "最强" }]);
  assert.equal(brief.copy_parameters.offer, "直播间限时福利");
  assert.equal(brief.copy_parameters.forbidden_terms, "最强");
  assert.equal(brief.copy_parameters.cta_policy, "点击下单");
  assert.equal(brief.product.category, "防晒气垫");
  assert.equal(brief.product_library.category, "防晒气垫");
});

test("product create writes optional category into product profile", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-product-test-"));
  const result = await run([
    "product",
    "create",
    "--workspace",
    workspace,
    "--slug",
    "demo",
    "--name",
    "Demo",
    "--brand",
    "DemoBrand",
    "--category",
    "口红"
  ]);
  assert.equal(result.code, 0, result.stderr);
  const product = JSON.parse(await readFile(path.join(workspace, "data", "products", "demo", "product.json"), "utf8"));
  assert.equal(product.schema_version, "voah.product.v1");
  assert.equal(product.category, "口红");
});

test("batch run --create-only writes batch and task manifests", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-batch-test-"));
  const intakeRun = path.join(workspace, "cache", "voah_video_intake", "demo", "run");
  await mkdir(intakeRun, { recursive: true });
  await writeFile(path.join(intakeRun, "shot_index.json"), JSON.stringify({ records: [] }));
  const result = await run([
    "batch",
    "run",
    "--workspace",
    workspace,
    "--product",
    "demo",
    "--intake-run",
    intakeRun,
    "--count",
    "2",
    "--concurrency",
    "2",
    "--resolution",
    "1080p",
    "--create-only"
  ]);
  assert.equal(result.code, 0, result.stderr);
  const batchDir = result.stdout.match(/batch_dir=(.*)/)?.[1].trim();
  assert.ok(batchDir);
  const batch = JSON.parse(await readFile(path.join(batchDir, "batch_manifest.json"), "utf8"));
  assert.equal(batch.tasks.length, 2);
  assert.equal(batch.concurrency, 2);
  assert.equal(batch.resolution, "1080p");
  assert.deepEqual(batch.canvas, { preset: "1080p", width: 1080, height: 1920, fps: 30 });
  for (const task of batch.tasks) {
    assert.ok(existsSync(path.join(task.task_dir, "task_manifest.json")));
    assert.ok(existsSync(path.join(task.task_dir, "task_brief.json")));
    const taskManifest = JSON.parse(await readFile(path.join(task.task_dir, "task_manifest.json"), "utf8"));
    assert.equal(taskManifest.resolution, "1080p");
    assert.deepEqual(taskManifest.canvas, { preset: "1080p", width: 1080, height: 1920, fps: 30 });
  }
});

test("task run lock rejects duplicate runners for same task dir", async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "voah-task-lock-test-"));
  const lock = await acquireTaskRunLock(taskDir, { stage: "render", scope: "test" });
  try {
    await assert.rejects(
      () => acquireTaskRunLock(taskDir, { stage: "render", scope: "test" }),
      /任务正在运行/
    );
  } finally {
    await releaseTaskRunLock(lock);
  }
  const nextLock = await acquireTaskRunLock(taskDir, { stage: "render", scope: "test" });
  await releaseTaskRunLock(nextLock);
});

test("intake merge builds product-level merged shot index", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-intake-merge-test-"));
  const runA = path.join(workspace, "cache", "voah_video_intake", "demo", "run_a");
  const runB = path.join(workspace, "cache", "voah_video_intake", "demo", "run_b");
  await mkdir(runA, { recursive: true });
  await mkdir(runB, { recursive: true });
  await writeFile(path.join(runA, "shot_index.json"), JSON.stringify({ records: [{ shot_id: "a1", visual_summary: "A" }] }));
  await writeFile(path.join(runB, "shot_index.json"), JSON.stringify({ records: [{ shot_id: "b1", visual_summary: "B" }] }));
  const result = await run(["intake", "merge", "--workspace", workspace, "--product", "demo", "--product-name", "Demo"]);
  assert.equal(result.code, 0, result.stderr);
  const mergedDir = result.stdout.match(/merged_run_dir=(.*)/)?.[1].trim();
  assert.ok(mergedDir);
  const merged = JSON.parse(await readFile(path.join(mergedDir, "shot_index.json"), "utf8"));
  assert.equal(merged.total_runs, 2);
  assert.equal(merged.total_shots, 2);
  assert.equal(merged.records[0].source_run_name, "run_a");
  assert.equal(merged.records[1].source_run_name, "run_b");
});

test("batch pause and resume update manifest control state", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-batch-pause-test-"));
  const intakeRun = path.join(workspace, "cache", "voah_video_intake", "demo", "run");
  await mkdir(intakeRun, { recursive: true });
  await writeFile(path.join(intakeRun, "shot_index.json"), JSON.stringify({ records: [] }));
  const create = await run([
    "batch",
    "run",
    "--workspace",
    workspace,
    "--product",
    "demo",
    "--intake-run",
    intakeRun,
    "--count",
    "1",
    "--create-only"
  ]);
  assert.equal(create.code, 0, create.stderr);
  const batchDir = create.stdout.match(/batch_dir=(.*)/)?.[1].trim();
  const pause = await run(["batch", "pause", "--workspace", workspace, batchDir]);
  assert.equal(pause.code, 0, pause.stderr);
  assert.ok(existsSync(path.join(batchDir, "batch_control.json")));
  const paused = JSON.parse(await readFile(path.join(batchDir, "batch_manifest.json"), "utf8"));
  assert.equal(paused.status, "paused");
  assert.equal(paused.control.paused, true);
  paused.tasks[0].status = "succeeded";
  paused.tasks[0].qa_status = "ok";
  await writeFile(path.join(batchDir, "batch_manifest.json"), `${JSON.stringify(paused, null, 2)}\n`);

  const resume = await run(["batch", "resume", "--workspace", workspace, batchDir]);
  assert.equal(resume.code, 0, resume.stderr);
  assert.equal(existsSync(path.join(batchDir, "batch_control.json")), false);
  const resumed = JSON.parse(await readFile(path.join(batchDir, "batch_manifest.json"), "utf8"));
  assert.equal(resumed.control.paused, false);
});

test("resource cleanup records resource manifest without secrets", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-resource-test-"));
  const runDir = path.join(workspace, "cache", "task");
  await mkdir(runDir, { recursive: true });
  const result = await run(["resource", "cleanup", "--workspace", workspace, "--run", runDir, "--expired-only"]);
  assert.equal(result.code, 0, result.stderr);
  const manifestText = await readFile(path.join(runDir, "resource_manifest.json"), "utf8");
  assert.doesNotMatch(manifestText, /sk-[A-Za-z0-9_-]{12,}/);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.cleanup.expired_only, true);
});

test("config get never prints stored secret values", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-config-test-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "voah-cli-config-home-"));
  const secret = "sk-test-secret-1234567890";
  const env = { ...process.env, VOAH_CONFIG_DIR: configDir };
  const setResult = await run(["config", "set", "dashscope.api_key", secret, "--workspace", workspace], { env });
  assert.equal(setResult.code, 0, setResult.stderr);
  const getResult = await run(["config", "get", "--workspace", workspace], { env });
  assert.equal(getResult.code, 0, getResult.stderr);
  assert.doesNotMatch(getResult.stdout, /sk-test-secret/);
  assert.match(getResult.stdout, /"dashscope.api_key": true/);
});

test("config set accepts secret value from stdin", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-config-stdin-test-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "voah-cli-config-stdin-home-"));
  const env = { ...process.env, VOAH_CONFIG_DIR: configDir };
  const setResult = await runWithInput(["config", "set", "deepseek.api_key", "--workspace", workspace], "sk-test-stdin-deepseek-1234567890\n", { env });
  assert.equal(setResult.code, 0, setResult.stderr);
  assert.match(setResult.stdout, /deepseek\.api_key=configured/);
  const getResult = await run(["config", "get", "--workspace", workspace], { env });
  assert.equal(getResult.code, 0, getResult.stderr);
  assert.doesNotMatch(getResult.stdout, /sk-test-stdin/);
  const payload = JSON.parse(getResult.stdout);
  assert.equal(payload.secrets["deepseek.api_key"], true);
});

test("config get groups visible model keys by provider", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-config-provider-test-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "voah-cli-config-provider-home-"));
  const env = { ...process.env, VOAH_CONFIG_DIR: configDir };
  const setResult = await run(["config", "set", "deepseek.api_key", "sk-test-deepseek-1234567890", "--workspace", workspace], { env });
  assert.equal(setResult.code, 0, setResult.stderr);
  const getResult = await run(["config", "get", "--workspace", workspace], { env });
  assert.equal(getResult.code, 0, getResult.stderr);
  assert.doesNotMatch(getResult.stdout, /sk-test-deepseek/);
  const payload = JSON.parse(getResult.stdout);
  assert.deepEqual(payload.providers.map((item) => item.id), ["dashscope", "minimax", "deepseek"]);
  assert.equal(payload.providers.find((item) => item.id === "deepseek").configured, true);
  assert.equal(payload.modules.find((item) => item.id === "copy_generation").provider_id, "deepseek");
  assert.equal(payload.modules.find((item) => item.id === "copy_generation").model, "deepseek-v4-pro");
});

test("task create uses category, not slug guessing, when product name is blank", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-product-name-test-"));
  const intakeRun = path.join(workspace, "cache", "voah_video_intake", "fangshai-qidian", "run");
  const productDir = path.join(workspace, "data", "products", "fangshai-qidian");
  await mkdir(intakeRun, { recursive: true });
  await mkdir(productDir, { recursive: true });
  await writeFile(path.join(intakeRun, "shot_index.json"), JSON.stringify({ records: [] }));
  await writeFile(path.join(productDir, "product.json"), JSON.stringify({ slug: "fangshai-qidian", name: "", brand: "", category: "防晒气垫" }));
  await writeFile(path.join(productDir, "claims.json"), JSON.stringify({ claims: [{ text: "防晒底妆二合一", tier: "core", rank: 1 }] }));
  await writeFile(path.join(productDir, "campaigns.json"), JSON.stringify({ campaigns: [] }));
  await writeFile(path.join(productDir, "blocked_terms.json"), JSON.stringify({ terms: [] }));
  const result = await run([
    "task",
    "create",
    "--workspace",
    workspace,
    "--product",
    "fangshai-qidian",
    "--intake-run",
    intakeRun
  ]);
  assert.equal(result.code, 0, result.stderr);
  const taskDir = result.stdout.match(/task_dir=(.*)/)?.[1].trim();
  const brief = JSON.parse(await readFile(path.join(taskDir, "task_brief.json"), "utf8"));
  assert.equal(brief.product.slug, "fangshai-qidian");
  assert.equal(brief.product.name, "");
  assert.equal(brief.product.brand, "");
  assert.equal(brief.product.category, "防晒气垫");
  assert.equal(brief.product.generic_name, "这款防晒气垫");
  assert.match(brief.constraints.join("\n"), /slug/);
});

test("resource upload failure records redacted manifest and public output", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-resource-upload-test-"));
  const runDir = path.join(workspace, "cache", "task");
  await mkdir(runDir, { recursive: true });
  const missing = path.join(workspace, "missing.mp4");
  const result = await run([
    "resource",
    "upload",
    "--workspace",
    workspace,
    "--run",
    runDir,
    "--file",
    missing,
    "--purpose",
    "omni_qa"
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /"remote_url"\s*:/);
  const manifestText = await readFile(path.join(runDir, "resource_manifest.json"), "utf8");
  assert.doesNotMatch(manifestText, /sk-[A-Za-z0-9_-]{12,}/);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.resources[0].status, "upload_failed");
});

test("batch result lists do not pass missing QA videos", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-batch-lists-test-"));
  const intakeRun = path.join(workspace, "cache", "voah_video_intake", "demo", "run");
  await mkdir(intakeRun, { recursive: true });
  await writeFile(path.join(intakeRun, "shot_index.json"), JSON.stringify({ records: [] }));
  const binDir = path.join(workspace, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    path.join(binDir, "python3"),
    `#!/bin/sh
case "$1" in
  *voah_generate_copy_with_m3.py)
    echo '{"full_voice_text":"demo","script_sections":[{"voice_text":"demo"}]}' > "$5/voice_script.json"
    echo '{}' > "$5/copy_brief.json"
    ;;
  *voah_run_oneshot_minimax_tts.py)
    touch "$5/voice.wav"
    echo '{}' > "$5/tts_audio.json"
    echo '{"sections":[]}' > "$5/audio_sections.json"
    ;;
  *voah_retrieve_fill_from_audio_sections.py)
    TASK=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--task-dir" ]; then shift; TASK="$1"; fi
      shift
    done
    echo '{}' > "$TASK/candidate_sections.json"
    echo '{}' > "$TASK/timeline_selection.json"
    echo '{}' > "$TASK/timeline_fill.json"
    touch "$TASK/preview_no_subtitles.mp4"
    ;;
  *voah_build_caption_plan.py)
    TASK=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--task-dir" ]; then shift; TASK="$1"; fi
      shift
    done
    echo '{}' > "$TASK/caption_plan.json"
    ;;
  *voah_create_hyperframes_subtitle_project.py)
    PROJECT=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--project-dir" ]; then shift; PROJECT="$1"; fi
      shift
    done
    mkdir -p "$PROJECT"
    echo '<html></html>' > "$PROJECT/index.html"
    echo '{}' > "$PROJECT/hyperframes_subtitle_burn_manifest.json"
    ;;
  *voah_write_full_pipeline_manifest.py)
    TASK="$3"
    echo '{"qa":{"status":"needs_review"}}' > "$TASK/full_pipeline_manifest.json"
    ;;
  *voah_build_desktop_quality_report.py)
    TASK="$3"
    echo '{}' > "$TASK/desktop_quality_report.json"
    ;;
  *)
    exit 1
    ;;
esac
`,
    { mode: 0o755 }
  );
  await writeFile(
    path.join(binDir, "ffmpeg"),
    `#!/bin/sh
OUT=""
for arg in "$@"; do OUT="$arg"; done
touch "$OUT"
`,
    { mode: 0o755 }
  );
  await writeFile(
    path.join(binDir, "npx"),
    `#!/bin/sh
IS_RENDER=0
for arg in "$@"; do
  if [ "$arg" = "render" ]; then IS_RENDER=1; fi
done
if [ "$IS_RENDER" = "1" ]; then
  OUT=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--output" ]; then shift; OUT="$1"; fi
    shift
  done
  touch "$OUT"
fi
exit 0
`,
    { mode: 0o755 }
  );
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  const result = await run([
    "batch",
    "run",
    "--workspace",
    workspace,
    "--product",
    "demo",
    "--intake-run",
    intakeRun,
    "--count",
    "2",
    "--concurrency",
    "2",
    "--skip-omni",
    "--render-timeout-ms",
    "1000"
  ], { env });
  assert.equal(result.code, 0, result.stderr);
  const batchDir = result.stdout.match(/batch_dir=(.*)/)?.[1].trim();
  const batch = JSON.parse(await readFile(path.join(batchDir, "batch_manifest.json"), "utf8"));
  assert.equal(batch.status, "needs_review");
  const passed = JSON.parse(await readFile(path.join(batchDir, "passed_videos.json"), "utf8"));
  assert.equal(passed.passed_count, 0);
  const review = JSON.parse(await readFile(path.join(batchDir, "needs_review_videos.json"), "utf8"));
  assert.equal(review.needs_review_count, 2);
});

test("retrieve stage resolves min clip and batch diversity state for batch tasks", () => {
  const taskDir = path.join(os.tmpdir(), "voah-task");
  const batchDir = path.join(os.tmpdir(), "voah-batch");
  const manifest = {
    batch: { batch_dir: batchDir },
    retrieval: { min_clip_duration_s: 3.1 }
  };

  assert.equal(retrieveMinClipDuration({}, manifest), 3.1);
  assert.equal(
    resolveRetrievalDiversityStatePath(taskDir, manifest, {}),
    path.join(batchDir, "retrieval_diversity_state.json")
  );
  assert.equal(resolveRetrievalDiversityStatePath(taskDir, manifest, { "batch-diversity-state": "off" }), "off");
  assert.equal(retrieveMinClipDuration({ "min-clip-duration-s": "2.7" }, manifest), 2.7);
});

test("qa stage skips final Omni by default", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-qa-skip-omni-"));
  const taskDir = path.join(workspace, "task");
  const marker = path.join(workspace, "omni-called.txt");
  await mkdir(path.join(taskDir, "hyperframes_subtitle_burn"), { recursive: true });
  await writeFile(path.join(taskDir, "task_manifest.json"), JSON.stringify({ schema_version: "voah.task_manifest.v1", status: "queued", active_artifacts: {}, stages: {} }));
  await writeFile(path.join(taskDir, "audio_sections.json"), JSON.stringify({ sections: [] }));
  await writeFile(path.join(taskDir, "timeline_fill.json"), JSON.stringify({ timeline: [] }));
  await writeFile(path.join(taskDir, "hyperframes_subtitle_burn", "final_subtitled.mp4"), "");
  const binDir = await writeQaFakeBin(workspace, { failOnOmni: true });
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, VOAH_FAKE_OMNI_MARKER: marker };

  const result = await run(["qa", "run", "--workspace", workspace, taskDir], { env });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(marker), false);
  const manifest = JSON.parse(await readFile(path.join(taskDir, "task_manifest.json"), "utf8"));
  assert.equal(manifest.status, "succeeded");
  assert.equal(manifest.active_artifacts.full_pipeline_manifest, "full_pipeline_manifest.json");
  assert.equal(manifest.active_artifacts.desktop_quality_report, "desktop_quality_report.md");
});

test("qa stage runs final Omni only when explicitly requested", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-qa-run-omni-"));
  const taskDir = path.join(workspace, "task");
  const marker = path.join(workspace, "omni-called.txt");
  await mkdir(path.join(taskDir, "hyperframes_subtitle_burn"), { recursive: true });
  await writeFile(path.join(taskDir, "task_manifest.json"), JSON.stringify({ schema_version: "voah.task_manifest.v1", status: "queued", active_artifacts: {}, stages: {} }));
  await writeFile(path.join(taskDir, "audio_sections.json"), JSON.stringify({ sections: [] }));
  await writeFile(path.join(taskDir, "timeline_fill.json"), JSON.stringify({ timeline: [] }));
  await writeFile(path.join(taskDir, "hyperframes_subtitle_burn", "final_subtitled.mp4"), "");
  const binDir = await writeQaFakeBin(workspace);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, VOAH_FAKE_OMNI_MARKER: marker };

  const result = await run(["qa", "run", "--workspace", workspace, taskDir, "--run-omni"], { env });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(marker), true);
  assert.equal(existsSync(path.join(taskDir, "qa_omni_alignment_final", "omni_alignment_results.json")), true);
});

test("batch resume refreshes old failed snapshot from successful task manifest", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-batch-refresh-test-"));
  const batchDir = path.join(workspace, "batch");
  const taskDir = path.join(batchDir, "tasks", "001_demo");
  await mkdir(path.join(taskDir, "hyperframes_subtitle_burn"), { recursive: true });
  await writeFile(path.join(taskDir, "hyperframes_subtitle_burn", "final_subtitled.mp4"), "");
  await writeFile(
    path.join(taskDir, "task_manifest.json"),
    JSON.stringify({
      schema_version: "voah.task_manifest.v1",
      status: "succeeded",
      qa: { status: "warning" },
      active_artifacts: { final_subtitled: "hyperframes_subtitle_burn/final_subtitled.mp4" },
      stages: {}
    })
  );
  await writeFile(
    path.join(batchDir, "batch_manifest.json"),
    JSON.stringify({
      schema_version: "voah.batch_manifest.v1",
      status: "partial_failed",
      concurrency: 1,
      tasks: [
        {
          task_id: "task_old",
          task_dir: taskDir,
          status: "failed",
          qa_status: "block",
          failed_stage: "copy",
          error_message: "old traceback"
        }
      ]
    })
  );
  const result = await run(["batch", "resume", "--workspace", workspace, batchDir]);

  assert.equal(result.code, 0, result.stderr);
  const batch = JSON.parse(await readFile(path.join(batchDir, "batch_manifest.json"), "utf8"));
  assert.equal(batch.status, "completed");
  assert.equal(batch.tasks[0].status, "succeeded");
  assert.equal(batch.tasks[0].qa_status, "warning");
  assert.equal(batch.tasks[0].failed_stage, undefined);
  assert.equal(batch.tasks[0].error_message, undefined);
  const passed = JSON.parse(await readFile(path.join(batchDir, "passed_videos.json"), "utf8"));
  assert.equal(passed.passed_count, 1);
  const review = JSON.parse(await readFile(path.join(batchDir, "needs_review_videos.json"), "utf8"));
  assert.equal(review.needs_review_count, 0);
});

test("pipeline writes stage outputs under run workspace before promoting stable artifacts", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-worktree-pipeline-"));
  const intakeRun = path.join(workspace, "cache", "voah_video_intake", "demo", "run");
  const binDir = path.join(workspace, "bin");
  await mkdir(intakeRun, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(intakeRun, "shot_index.json"), JSON.stringify({ records: [] }));
  await writeFile(
    path.join(binDir, "python3"),
    `#!/bin/sh
case "$1" in
  *voah_generate_copy_with_m3.py)
    TASK=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--task-dir" ]; then shift; TASK="$1"; fi
      shift
    done
    echo '{"full_voice_text":"demo","script_sections":[{"voice_text":"demo"}]}' > "$TASK/voice_script.json"
    echo '{}' > "$TASK/copy_brief.json"
    ;;
  *voah_run_oneshot_minimax_tts.py)
    TASK=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--task-dir" ]; then shift; TASK="$1"; fi
      shift
    done
    touch "$TASK/voice.wav"
    echo '{}' > "$TASK/tts_audio.json"
    echo '{"sections":[]}' > "$TASK/audio_sections.json"
    ;;
  *voah_retrieve_fill_from_audio_sections.py)
    TASK=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--task-dir" ]; then shift; TASK="$1"; fi
      shift
    done
    echo '{}' > "$TASK/candidate_sections.json"
    echo '{}' > "$TASK/timeline_selection.json"
    echo '{}' > "$TASK/timeline_fill.json"
    touch "$TASK/preview_no_subtitles.mp4"
    ;;
  *voah_build_caption_plan.py)
    TASK=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--task-dir" ]; then shift; TASK="$1"; fi
      shift
    done
    echo '{"captions":[],"summary":{"total_duration_s":0},"style":{}}' > "$TASK/caption_plan.json"
    ;;
  *voah_create_hyperframes_subtitle_project.py)
    PROJECT=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--project-dir" ]; then shift; PROJECT="$1"; fi
      shift
    done
    mkdir -p "$PROJECT/media"
    echo '<html></html>' > "$PROJECT/index.html"
    echo '{}' > "$PROJECT/hyperframes_subtitle_burn_manifest.json"
    touch "$PROJECT/media/base_video.mp4"
    touch "$PROJECT/media/voice.wav"
    ;;
  *voah_write_full_pipeline_manifest.py)
    TASK=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--task-dir" ]; then shift; TASK="$1"; fi
      shift
    done
    echo '{"qa":{"status":"needs_review"}}' > "$TASK/full_pipeline_manifest.json"
    ;;
  *voah_build_desktop_quality_report.py)
    TASK=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--task-dir" ]; then shift; TASK="$1"; fi
      shift
    done
    echo '{}' > "$TASK/desktop_quality_report.json"
    echo '# report' > "$TASK/desktop_quality_report.md"
    ;;
  *)
    exit 1
    ;;
esac
`,
    { mode: 0o755 }
  );
  await writeFile(
    path.join(binDir, "ffmpeg"),
    `#!/bin/sh
OUT=""
for arg in "$@"; do OUT="$arg"; done
touch "$OUT"
`,
    { mode: 0o755 }
  );
  await writeFile(
    path.join(binDir, "npx"),
    `#!/bin/sh
IS_RENDER=0
for arg in "$@"; do
  if [ "$arg" = "render" ]; then IS_RENDER=1; fi
done
if [ "$IS_RENDER" = "1" ]; then
  OUT=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--output" ]; then shift; OUT="$1"; fi
    shift
  done
  touch "$OUT"
fi
exit 0
`,
    { mode: 0o755 }
  );
  const created = await run([
    "task",
    "create",
    "--workspace",
    workspace,
    "--product",
    "demo",
    "--intake-run",
    intakeRun
  ]);
  assert.equal(created.code, 0, created.stderr);
  const taskDir = created.stdout.match(/task_dir=(.*)/)?.[1].trim();
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  const result = await run(["task", "run", "--workspace", workspace, taskDir, "--skip-omni", "--render-timeout-ms", "1000"], { env });
  assert.equal(result.code, 0, result.stderr);
  const runsDir = path.join(taskDir, ".runs");
  assert.equal(existsSync(runsDir), true);
  const runNames = (await import("node:fs/promises")).readdir(runsDir);
  const names = await runNames;
  assert.equal(names.length, 1);
  const runDir = path.join(runsDir, names[0]);
  assert.equal(existsSync(path.join(runDir, "outputs", "voice_script.json")), true);
  assert.equal(existsSync(path.join(runDir, "outputs", "hyperframes_subtitle_burn", "final_subtitled.mp4")), true);
  assert.equal(existsSync(path.join(taskDir, "hyperframes_subtitle_burn", "final_subtitled.mp4")), true);
  const manifest = JSON.parse(await readFile(path.join(taskDir, "task_manifest.json"), "utf8"));
  assert.equal(manifest.runs.latest, names[0]);
  assert.equal(manifest.stages.render.promoted_run_id, names[0]);
  assert.equal(manifest.active_artifacts.final_subtitled, "hyperframes_subtitle_burn/final_subtitled.mp4");
});

test("tts preview dry-run writes manifest without secrets", async () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "voah-cli-tts-preview-out-"));
  const result = await run([
    "tts",
    "preview",
    "--workspace",
    repoRoot,
    "--text",
    "今天给大家测试一下气垫",
    "--dry-run",
    "--timestamp",
    "run001",
    "--output-root",
    outputRoot
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /dry_run=true/);
  const manifestText = await readFile(path.join(outputRoot, "run001", "manifest.json"), "utf8");
  assert.doesNotMatch(manifestText, /sk-[A-Za-z0-9_-]{12,}/);
});

test("tts preview dry-run passes studio voice parameters into payload", async () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "voah-cli-tts-preview-params-"));
  const result = await run([
    "tts",
    "preview",
    "--workspace",
    repoRoot,
    "--text",
    "今天给大家测试一下气垫",
    "--dry-run",
    "--timestamp",
    "run002",
    "--output-root",
    outputRoot,
    "--provider",
    "minimax-official",
    "--model",
    "speech-2.8-hd",
    "--voice-id",
    "voice-demo",
    "--speed",
    "1.15",
    "--vol",
    "1.2",
    "--pitch",
    "2",
    "--emotion",
    "happy",
    "--modify-pitch",
    "20",
    "--modify-intensity",
    "21",
    "--modify-timbre",
    "0"
  ]);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(await readFile(path.join(outputRoot, "run002", "minimax_payload.safe.json"), "utf8"));
  assert.equal(payload.model, "speech-2.8-hd");
  assert.deepEqual(payload.voice_setting, {
    voice_id: "voice-demo",
    speed: 1.15,
    vol: 1.2,
    pitch: 2,
    emotion: "happy"
  });
  assert.deepEqual(payload.voice_modify, {
    pitch: 20,
    intensity: 21,
    timbre: 0
  });
});

test("tts preview requires text input", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-tts-preview-empty-"));
  const result = await run(["tts", "preview", "--workspace", workspace]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--text/);
});

test("pipeline records stage output hashes and detects upstream change", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "voah-cli-hash-stale-test-"));
  const intakeRun = path.join(workspace, "cache", "voah_video_intake", "demo", "run");
  await mkdir(intakeRun, { recursive: true });
  await writeFile(path.join(intakeRun, "shot_index.json"), JSON.stringify({ records: [] }));
  const created = await run([
    "task",
    "create",
    "--workspace",
    workspace,
    "--product",
    "demo",
    "--intake-run",
    intakeRun
  ]);
  assert.equal(created.code, 0, created.stderr);
  const taskDir = created.stdout.match(/task_dir=(.*)/)?.[1].trim();
  // 手工写入一个已成功的 copy 阶段及其产物 hash 基线，模拟跑过 copy。
  const { recordStageOutputHashes, markStage, detectUpstreamChange } = await import("../src/core/manifest.js");
  await writeFile(path.join(taskDir, "voice_script.json"), JSON.stringify({ full_voice_text: "v1" }));
  await writeFile(path.join(taskDir, "copy_brief.json"), JSON.stringify({ ok: true }));
  await markStage(taskDir, "copy", { status: "succeeded" });
  await recordStageOutputHashes(taskDir, "copy");
  // 未变更：检测应为 null。
  assert.equal(await detectUpstreamChange(taskDir, "tts"), null);
  // 变更 voice_script.json：检测应指向 copy。
  await writeFile(path.join(taskDir, "voice_script.json"), JSON.stringify({ full_voice_text: "v2-changed" }));
  assert.equal(await detectUpstreamChange(taskDir, "tts"), "copy");
});
