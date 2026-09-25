/**
 * Brute-force protection (design §6.1): 5 failed logins per username per 15 minutes locks that
 * username for 15 minutes, plus a per-IP budget for everything under /auth and connection tests.
 * In memory on purpose: a restart resets it, which is acceptable for a single-process server.
 */

export interface ThrottleOptions {
  maxFailures: number;
  windowMs: number;
  ipLimit: number;
  ipWindowMs: number;
}

const DEFAULTS: ThrottleOptions = { maxFailures: 5, windowMs: 15 * 60_000, ipLimit: 60, ipWindowMs: 5 * 60_000 };

export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();
  private readonly ipHits = new Map<string, number[]>();
  private readonly opts: ThrottleOptions;

  constructor(
    opts: Partial<ThrottleOptions> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  private recent(map: Map<string, number[]>, key: string, windowMs: number): number[] {
    const t = this.now();
    const list = (map.get(key) ?? []).filter((x) => x > t - windowMs);
    map.set(key, list);
    return list;
  }

  /** Counts a request from `ip`; false when the IP is over budget. */
  allowIp(ip: string | undefined): boolean {
    if (!ip) return true;
    const list = this.recent(this.ipHits, ip, this.opts.ipWindowMs);
    if (list.length >= this.opts.ipLimit) return false;
    list.push(this.now());
    return true;
  }

  /** Seconds until the username may try again, or 0. */
  lockedFor(username: string): number {
    const list = this.recent(this.failures, username.toLowerCase(), this.opts.windowMs);
    if (list.length < this.opts.maxFailures) return 0;
    return Math.ceil((list[0]! + this.opts.windowMs - this.now()) / 1000);
  }

  /** Records a failure; returns true if this failure triggered a lockout. */
  fail(username: string): boolean {
    const key = username.toLowerCase();
    const list = this.recent(this.failures, key, this.opts.windowMs);
    list.push(this.now());
    return list.length === this.opts.maxFailures;
  }

  succeed(username: string) {
    this.failures.delete(username.toLowerCase());
  }
}
