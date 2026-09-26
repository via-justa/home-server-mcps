/**
 * Sliding windows of hit timestamps per key, bounded in memory: keys whose window has passed are
 * dropped, and past `maxKeys` the keys with the fewest hits go first. Callers keyed by anything a client
 * chooses (usernames, IPs, principals) can't grow it without limit.
 */
export class HitWindows {
  private readonly map = new Map<string, { hits: number[]; windowMs: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  get size(): number {
    return this.map.size;
  }

  /** Hits for `key` within the window (oldest first). */
  recent(key: string, windowMs: number): number[] {
    const entry = this.map.get(key);
    if (!entry) return [];
    const t = this.now();
    const hits = entry.hits.filter((h) => h > t - windowMs);
    this.map.delete(key);
    if (hits.length) this.map.set(key, { hits, windowMs }); // re-insert: most recently used last
    return hits;
  }

  add(key: string, windowMs: number): number[] {
    const hits = [...this.recent(key, windowMs), this.now()];
    this.map.set(key, { hits, windowMs });
    if (this.map.size > this.maxKeys) this.prune();
    return hits;
  }

  delete(key: string) {
    this.map.delete(key);
  }

  /**
   * Drops keys whose window has passed, then the keys with the fewest hits (oldest first among equals),
   * down to 90% of the cap. A flood of one-off keys therefore can't push out a key that is close to or
   * at its limit, such as a username that is locked out.
   */
  private prune() {
    const t = this.now();
    for (const [k, e] of this.map) if (e.hits.at(-1)! <= t - e.windowMs) this.map.delete(k);
    const target = Math.floor(this.maxKeys * 0.9);
    if (this.map.size <= target) return;
    const byHits = [...this.map].map(([k, e], order) => ({ k, n: e.hits.length, order }));
    byHits.sort((a, b) => a.n - b.n || a.order - b.order);
    for (const { k } of byHits.slice(0, this.map.size - target)) this.map.delete(k);
  }
}

/**
 * In-memory sliding-window limiter for per-instance execute/write caps (design §5.2). Separate from
 * pre-approval rule limits, which are persisted in `pre_approval_hits`.
 */
export class SlidingWindowLimiter {
  private readonly hits: HitWindows;

  constructor(now: () => number = Date.now, maxKeys?: number) {
    this.hits = new HitWindows(now, maxKeys);
  }

  get size(): number {
    return this.hits.size;
  }

  /** Records a hit and returns true if it fits within `limit` per `windowMs`; otherwise records nothing. */
  take(key: string, limit: number, windowMs: number): boolean {
    if (this.hits.recent(key, windowMs).length >= limit) return false;
    this.hits.add(key, windowMs);
    return true;
  }
}
