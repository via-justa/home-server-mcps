/**
 * Redaction (design §5.5): replaces values under sensitive keys before anything reaches the model,
 * the audit log, pending approvals or the portal. Keys match case-insensitively, ignoring `_`/`-`,
 * so `apiKey`, `api_key` and `API-KEY` are one rule.
 */

export const REDACTED = '[REDACTED]';

export const GLOBAL_SENSITIVE_KEYS = [
  'password',
  'passphrase',
  'secret',
  'token',
  'apiKey',
  'privateKey',
  'bindpw',
  'authPass',
  'accessToken',
  'refreshToken',
  'clientSecret',
];

const normalize = (key: string) => key.toLowerCase().replace(/[_-]/g, '');

export type Redactor = <T>(value: T) => T;

export function createRedactor(...keyLists: (readonly string[] | undefined)[]): Redactor {
  const keys = new Set(keyLists.flatMap((l) => l ?? []).map(normalize));
  const walk = (value: unknown, seen: WeakSet<object>): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => walk(v, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = keys.has(normalize(k)) && v !== null && v !== undefined && v !== '' ? REDACTED : walk(v, seen);
    }
    return out;
  };
  return <T>(value: T) => walk(value, new WeakSet()) as T;
}
