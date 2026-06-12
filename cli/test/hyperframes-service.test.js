import test from "node:test";
import assert from "node:assert/strict";
import {
  hyperframesBaseRenderArgs,
  hyperframesRenderSettingsForManifest,
  resolveHyperframesRenderOptions
} from "../src/services/hyperframesService.js";

test("hyperframes render defaults keep Mac conservative", () => {
  const options = resolveHyperframesRenderOptions({ platform: "darwin" });
  assert.equal(options.workers, "1");
  assert.equal(options.browser_gpu, false);

  const args = hyperframesBaseRenderArgs({
    output: "/tmp/final.mp4",
    renderOptions: { platform: "darwin" }
  });
  assert.deepEqual(args.slice(args.indexOf("--workers"), args.indexOf("--workers") + 2), ["--workers", "1"]);
  assert.equal(args.includes("--no-browser-gpu"), true);
  assert.equal(args.includes("--gpu"), false);
});

test("hyperframes render defaults enable hardware on Windows and Linux", () => {
  for (const platform of ["win32", "linux"]) {
    const options = resolveHyperframesRenderOptions({ platform });
    assert.equal(options.workers, "auto");
    assert.equal(options.browser_gpu, true);

    const args = hyperframesBaseRenderArgs({
      output: "/tmp/final.mp4",
      renderOptions: { platform }
    });
    assert.deepEqual(args.slice(args.indexOf("--workers"), args.indexOf("--workers") + 2), ["--workers", "auto"]);
    assert.equal(args.includes("--gpu"), true);
    assert.equal(args.includes("--no-browser-gpu"), false);
  }
});

test("hyperframes render explicit options override platform defaults", () => {
  const settings = hyperframesRenderSettingsForManifest({
    platform: "darwin",
    workers: "4",
    gpu: true
  });
  assert.equal(settings.workers, "4");
  assert.equal(settings.browser_gpu, true);
  assert.equal(settings.source.workers, "configured");
  assert.equal(settings.source.browser_gpu, "configured");

  const disabled = hyperframesRenderSettingsForManifest({
    platform: "win32",
    workers: "12",
    "no-gpu": true
  });
  assert.equal(disabled.workers, "8");
  assert.equal(disabled.browser_gpu, false);
});
