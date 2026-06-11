import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const CLI = fileURLToPath(new URL("../src/bin/voah.js", import.meta.url));

function run(args, options = {}) {
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], options, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr, code: error?.code || 0 });
    });
  });
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
  await mkdir(intakeRun, { recursive: true });
  await writeFile(path.join(intakeRun, "shot_index.json"), JSON.stringify({ records: [] }));
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
    "/tmp/VoahFont.ttf"
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
    "--create-only"
  ]);
  assert.equal(result.code, 0, result.stderr);
  const batchDir = result.stdout.match(/batch_dir=(.*)/)?.[1].trim();
  assert.ok(batchDir);
  const batch = JSON.parse(await readFile(path.join(batchDir, "batch_manifest.json"), "utf8"));
  assert.equal(batch.tasks.length, 2);
  assert.equal(batch.concurrency, 2);
  for (const task of batch.tasks) {
    assert.ok(existsSync(path.join(task.task_dir, "task_manifest.json")));
    assert.ok(existsSync(path.join(task.task_dir, "task_brief.json")));
  }
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
