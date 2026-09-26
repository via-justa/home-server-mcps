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

/** Secret values shorter than this are not scrubbed from text: too likely to match ordinary words. */
const MIN_SCRUB_LENGTH = 6;

export function createRedactor(...keyLists: (readonly string[] | undefined)[]): Redactor {
  return createInstanceRedactor({ keyLists });
}

/**
 * The redactor for one instance: values under sensitive keys, plus the instance's actual secret values
 * wherever they appear inside a string (log lines, previews, error messages, notification text), since
 * text has no keys to go by.
 */
export function createInstanceRedactor(opts: {
  keyLists: (readonly string[] | undefined)[];
  secretValues?: readonly string[];
}): Redactor {
  const keys = new Set(opts.keyLists.flatMap((l) => l ?? []).map(normalize));
  const needles = [
    ...new Set(
      (opts.secretValues ?? [])
        .filter((v) => typeof v === 'string' && v.length >= MIN_SCRUB_LENGTH)
        .flatMap((v) => [v, encodeURIComponent(v), JSON.stringify(v).slice(1, -1)]),
    ),
  ].sort((a, b) => b.length - a.length);
  const scrub = (text: string) => (needles.length ? needles.reduce((t, n) => t.split(n).join(REDACTED), text) : text);
  const walk = (value: unknown, seen: WeakSet<object>): unknown => {
    if (typeof value === 'string') return scrub(value);
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => walk(v, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[scrub(k)] = keys.has(normalize(k)) && v !== null && v !== undefined && v !== '' ? REDACTED : walk(v, seen);
    }
    return out;
  };
  return <T>(value: T) => walk(value, new WeakSet()) as T;
}
