import { createHash } from 'node:crypto';

/** JSON with object keys sorted recursively, so equal values always serialize identically. */
export function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          )
        : v,
    ) ?? 'null'
  );
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
