import { UserError } from "./errors.js";

export function parseArgs(argv, spec = {}) {
  const options = {};
  const positional = [];
  const boolean = new Set(spec.boolean || []);
  const aliases = spec.aliases || {};
  const defaults = spec.defaults || {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      positional.push(token);
      continue;
    }
    const normalized = token.startsWith("--") ? token.slice(2) : token.slice(1);
    const [rawKey, inlineValue] = normalized.split(/=(.*)/s).filter((part) => part !== undefined);
    const key = aliases[rawKey] || rawKey;
    if (boolean.has(key)) {
      options[key] = inlineValue === undefined ? true : !["0", "false", "no"].includes(String(inlineValue).toLowerCase());
      continue;
    }
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || (next.startsWith("-") && !isNumericLiteral(next))) {
      throw new UserError(`缺少参数值：--${rawKey}`);
    }
    options[key] = next;
    index += 1;
  }

  return {
    ...defaults,
    ...options,
    _: positional
  };
}

function isNumericLiteral(value) {
  return /^-?\d+(?:\.\d+)?$/.test(String(value || ""));
}

export function requireOption(options, key, label = key) {
  const value = options[key];
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new UserError(`缺少必填参数：--${label}`);
  }
  return String(value);
}

export function optionalNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new UserError(`参数必须是数字：${value}`);
  }
  return number;
}

export function optionalInt(value, fallback) {
  return Math.round(optionalNumber(value, fallback));
}
