import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "../core/args.js";
import { writeJson } from "../core/json.js";
import { compactDateTime, ensureDir, resolveWorkspace } from "../core/paths.js";
import { SecretService } from "../services/secretService.js";
import { toolStatus } from "../services/toolchainService.js";

export async function runDoctorCommand({ argv }) {
  const options = parseArgs(argv, { aliases: { w: "workspace" } });
  const workspace = resolveWorkspace(options.workspace);
  const outputDir = path.join(workspace, "cache", "voah_system", "doctor", `${compactDateTime()}_doctor`);
  await ensureDir(outputDir);
  const secretService = new SecretService({ workspace });
  const tools = await toolStatus(workspace);
  const keys = await secretService.keyStatus();
  const report = {
    schema_version: "voah.doctor_report.v1",
    created_at: new Date().toISOString(),
    workspace: {
      path: workspace,
      exists: existsSync(workspace),
      cache_exists: existsSync(path.join(workspace, "cache")),
      scripts_exists: existsSync(path.join(workspace, "scripts"))
    },
    tools,
    model_keys: keys,
    qa: {
      status: tools.every((item) => item.ok) && keys.every((item) => item.configured) ? "ok" : "warning",
      missing_tools: tools.filter((item) => !item.ok).map((item) => item.tool),
      missing_keys: keys.filter((item) => !item.configured).map((item) => item.env_key)
    },
    outputs: {
      doctor_report: path.join(outputDir, "doctor_report.json")
    }
  };
  await writeJson(report.outputs.doctor_report, report);
  console.log(`doctor_report=${report.outputs.doctor_report}`);
  console.log(`qa=${report.qa.status}`);
  if (report.qa.missing_tools.length) {
    console.log(`missing_tools=${report.qa.missing_tools.join(",")}`);
  }
  if (report.qa.missing_keys.length) {
    console.log(`missing_keys=${report.qa.missing_keys.join(",")}`);
  }
}
