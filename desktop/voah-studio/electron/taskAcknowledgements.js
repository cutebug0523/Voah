export const TASK_ACK_SCHEMA_VERSION = "voah.studio_task_acknowledgements.v1";

export function normalizeTaskAcknowledgements(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const raw = source.acknowledgements || {};
  const acknowledgements = {};

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const key = normalizeKey(item?.key || item?.id || item?.ack_key);
      if (key) acknowledgements[key] = { ...item, key };
    }
  } else if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) {
      const normalized = normalizeKey(key);
      if (!normalized) continue;
      acknowledgements[normalized] = {
        ...(value && typeof value === "object" ? value : {}),
        key: normalized
      };
    }
  }

  return {
    schema_version: source.schema_version || TASK_ACK_SCHEMA_VERSION,
    acknowledgements
  };
}

export function taskAcknowledgementKeys(task = {}) {
  return uniqueKeys([task.ack_key, ...(Array.isArray(task.ack_keys) ? task.ack_keys : []), task.id]);
}

export function isTaskAcknowledged(task, payload) {
  const normalized = normalizeTaskAcknowledgements(payload);
  return taskAcknowledgementKeys(task).some((key) => Boolean(normalized.acknowledgements[key]));
}

export function withTaskAcknowledgement(payload, task, acknowledgedAt = new Date().toISOString()) {
  const normalized = normalizeTaskAcknowledgements(payload);
  const keys = taskAcknowledgementKeys(task);
  for (const key of keys) {
    normalized.acknowledgements[key] = {
      key,
      kind: task.kind || "",
      status: task.status || "",
      title: task.title || task.product_name || "",
      target_path: task.target_path || "",
      acknowledged_at: acknowledgedAt
    };
  }
  normalized.updated_at = acknowledgedAt;
  return normalized;
}

function uniqueKeys(values) {
  const seen = new Set();
  const keys = [];
  for (const value of values) {
    const key = normalizeKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function normalizeKey(value) {
  return String(value || "").trim();
}
