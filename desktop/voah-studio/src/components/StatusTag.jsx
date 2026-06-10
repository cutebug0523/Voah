import { taskStatusMeta } from "../lib/status.js";

export function StatusTag({ status }) {
  const meta = taskStatusMeta(status);
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${meta.color}`}>
      <i className={`fa ${meta.icon}`} />
      {meta.label}
    </span>
  );
}
