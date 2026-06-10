const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]+/gi,
  /(\bBearer\s+)[A-Za-z0-9._-]{12,}/g,
  /eyJ[A-Za-z0-9._-]{20,}/g,
  /([?&](?:X-Amz-Signature|Signature|Expires|OSSAccessKeyId|security-token|sts_token|access_key_id|access_key_secret)=)[^&\s"]+/gi,
  /([?&](?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|sign|signature)=)[^&\s"]+/gi
];

export function redactText(value) {
  let output = String(value || "");
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, prefix = "") => (prefix ? `${prefix}<redacted>` : "<redacted>"));
  }
  return output;
}

export function redactObject(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (/key|token|secret|authorization|signature/i.test(key)) {
          if (typeof item === "boolean") return [key, item];
          return [key, item ? "<redacted>" : item];
        }
        if (/url|uri|endpoint|href/i.test(key) && typeof item === "string") {
          return [key, redactText(item)];
        }
        return [key, redactObject(item)];
      })
    );
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  return value;
}
