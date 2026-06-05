import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  stripRendererUnsafeFields,
  summarizeIntakeRun
} from "./intakeSummary.js";

const ARTIFACT_FILES = {
  run_manifest: "run_manifest.json",
  assets: "assets.json",
  story_units: "story_units.json",
  physical_shots: "physical_shots.json",
  embedding_results: "embedding_results.json"
};

export async function scanIntakeRunSummaries({
  workspaceRoot,
  productSlug,
  intakeRoot = path.join(workspaceRoot, "cache", "voah_video_intake")
}) {
  const productRoot = path.join(intakeRoot, productSlug);

  if (!existsSync(productRoot)) {
    return [];
  }

  const runNames = await readdir(productRoot, { withFileTypes: true });
  const summaries = await Promise.all(
    runNames
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const runDir = path.join(productRoot, entry.name);
        const artifacts = await readRunArtifacts(runDir);

        if (!artifacts.run_manifest) {
          return null;
        }

        return summarizeIntakeRun({
          runDir: toWorkspaceRelativePath(workspaceRoot, runDir),
          productSlug,
          runLabel: entry.name,
          artifacts
        });
      })
  );

  return summaries
    .filter(Boolean)
    .sort((a, b) => String(b.created_at || b.run_label).localeCompare(String(a.created_at || a.run_label)));
}

export async function readRunArtifacts(runDir) {
  const entries = await Promise.all(
    Object.entries(ARTIFACT_FILES).map(async ([kind, filename]) => {
      const artifactPath = path.join(runDir, filename);

      if (!existsSync(artifactPath)) {
        return [kind, null];
      }

      const content = await readFile(artifactPath, "utf8");
      return [kind, stripRendererUnsafeFields(JSON.parse(content))];
    })
  );

  return Object.fromEntries(entries.filter(([, value]) => value));
}

function toWorkspaceRelativePath(workspaceRoot, targetPath) {
  const relativePath = path.relative(workspaceRoot, targetPath);
  return relativePath.startsWith("..") ? targetPath : relativePath;
}
