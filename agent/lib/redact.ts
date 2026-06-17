const SECRET_PATTERNS = [
  /(authorization:\s*(?:bearer|token|basic)\s+)[^\s"']+/gi,
  /(private-token:\s*)[^\s"']+/gi,
  /(x-gitlab-token:\s*)[^\s"']+/gi,
  /(x-hub-signature-256:\s*sha256=)[a-f0-9]+/gi,
  /("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password)"?\s*[:=]\s*"?)[^"',\s}]+/gi,
  /gh[opsu]_[A-Za-z0-9_]+/g,
  /ghs_[A-Za-z0-9_]+/g,
  /glpat-[A-Za-z0-9_-]+/g,
];

export function redact(value: string, maxLength = 12000): string {
  let output = value;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (_match, prefix) =>
      typeof prefix === "string" ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  if (output.length <= maxLength) return output;
  return `${output.slice(0, maxLength)}\n[truncated ${output.length - maxLength} bytes]`;
}
