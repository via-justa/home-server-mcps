/**
 * In-memory sliding-window limiter for per-instance execute/write caps (design §5.2). Separate from
 * pre-approval rule limits, which are persisted in `pre_approval_hits`.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Records a hit and returns true if it fits within `limit` per `windowMs`; otherwise records nothing. */
  take(key: string, limit: number, windowMs: number): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => h > t - windowMs);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}
