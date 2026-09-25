export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function ago(value: string | Date | null | undefined, now = Date.now()): string {
  if (!value) return 'never';
  const d = typeof value === 'string' ? new Date(value) : value;
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 0) return `in ${until(d, now)}`;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function until(value: string | Date, now = Date.now()): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  const s = Math.max(0, Math.round((d.getTime() - now) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const pretty = (v: unknown) => JSON.stringify(v, null, 2);

export const AUTH_MODE_LABELS: Record<string, string> = {
  external: 'External (proxy)',
  bearer: 'Bearer token',
  oauth: 'OAuth',
  'bearer+oauth': 'Bearer or OAuth',
};

export const REASON_LABELS: Record<string, string> = {
  group_none: 'Group is off',
  excluded: 'Excluded',
  group_read_only: 'Group is read-only',
  locked_not_opted_in: 'Locked — not allowed',
  pending_review: 'Pending review',
  group_missing: 'No group',
  unknown_operation: 'Unknown',
};
