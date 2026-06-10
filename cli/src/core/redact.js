const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]+/gi,
  /([?&](?:X-Amz-Signature|Signature|Expires|OSSAccessKeyId|security-token)=)[^&\s"]+/gi
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
        if (/url/i.test(key) && typeof item === "string" && /[?&](Signature|X-Amz-Signature|OSSAccessKeyId)=/i.test(item)) {
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
