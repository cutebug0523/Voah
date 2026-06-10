import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_WORKSPACE = "/Users/noah/混剪";

export function resolveWorkspace(value) {
  return path.resolve(expandHome(value || process.env.VOAH_WORKSPACE || DEFAULT_WORKSPACE));
}

export function expandHome(value) {
  const text = String(value || "");
  if (text === "~") {
    return os.homedir();
  }
  if (text.startsWith("~/")) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

export function resolvePath(value, base = process.cwd()) {
  const expanded = expandHome(value);
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(base, expanded));
}

export function compactDateTime(date = new Date()) {
  const pad = (number) => String(number).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

export function slugify(input, fallback = "task") {
  const slug = String(input || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

export function compactId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function readJsonIfExists(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function relativeOrAbsolute(file, base) {
  if (!file) return "";
  return path.isAbsolute(file) ? file : path.join(base, file);
}
