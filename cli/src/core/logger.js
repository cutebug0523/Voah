import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { redactObject, redactText } from "./redact.js";

export class StageLogger {
  constructor({ logsDir, stage, runId }) {
    this.logsDir = logsDir;
    this.stage = stage;
    this.runId = runId;
    this.jsonlPath = path.join(logsDir, `${stage}.jsonl`);
    this.stdoutPath = path.join(logsDir, `${stage}.stdout.log`);
    this.stderrPath = path.join(logsDir, `${stage}.stderr.log`);
  }

  async init() {
    await mkdir(this.logsDir, { recursive: true });
  }

  async event(level, event, data = {}) {
    await this.init();
    const payload = {
      ts: new Date().toISOString(),
      level,
      stage: this.stage,
      run_id: this.runId,
      event,
      data: redactObject(data)
    };
    await appendFile(this.jsonlPath, `${JSON.stringify(payload)}\n`, "utf8");
  }

  async stdout(text) {
    await this.init();
    if (text) await appendFile(this.stdoutPath, redactText(text), "utf8");
  }

  async stderr(text) {
    await this.init();
    if (text) await appendFile(this.stderrPath, redactText(text), "utf8");
  }
}
