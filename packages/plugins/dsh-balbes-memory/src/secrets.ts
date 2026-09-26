export interface SecretMatch {
  rule: string;
}

interface SecretRule {
  name: string;
  pattern: RegExp;
}

/** Patterns are stateless (no /g) so repeated .test calls are safe. */
const RULES: readonly SecretRule[] = [
  { name: "provider-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: "github-token", pattern: /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { name: "slack-token", pattern: /\bxox[bp]-[A-Za-z0-9-]{10,}/ },
  { name: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "telegram-token", pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { name: "private-key", pattern: /-----BEGIN[^-]*PRIVATE KEY-----/ },
  { name: "assignment", pattern: /\b(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*\S+/i },
  { name: "connection-string", pattern: /:\/\/[^/:\s]+:[^/@\s]+@/ },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}/i }
];

/**
 * Detect a secret-looking fragment. Returns the rule name only — never the
 * matched value — so an error message cannot leak the secret into logs.
 */
export function detectSecret(text: string): SecretMatch | null {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return { rule: rule.name };
  }
  return null;
}
