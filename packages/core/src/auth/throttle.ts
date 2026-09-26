/**
 * Brute-force protection (design §6.1): 5 failed logins per username per 15 minutes locks that
 * username for 15 minutes, plus a per-IP budget for everything under /auth and connection tests.
 * In memory on purpose: a restart resets it, which is acceptable for a single-process server.
 *
 * Failures are counted **per surface**: attempts on the internet-facing MCP-port sign-in can lock a
 * username there, but never lock it out of the LAN admin portal.
 */

import { HitWindows } from '../gate/rate-limit.js';

export type LoginSurface = 'admin' | 'mcp';
const failureKey = (username: string, surface: LoginSurface) => `${surface}:${username.toLowerCase()}`;

export interface ThrottleOptions {
  maxFailures: number;
  windowMs: number;
  ipLimit: number;
  ipWindowMs: number;
}

const DEFAULTS: ThrottleOptions = { maxFailures: 5, windowMs: 15 * 60_000, ipLimit: 60, ipWindowMs: 5 * 60_000 };

export class LoginThrottle {
  private readonly failures: HitWindows;
  private readonly ipHits: HitWindows;
  private readonly opts: ThrottleOptions;

  constructor(
    opts: Partial<ThrottleOptions> = {},
    private readonly now: () => number = Date.now,
    maxKeys?: number,
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    // Bounded: random usernames or spoofed IPs from the internet can't grow these without limit.
    this.failures = new HitWindows(now, maxKeys);
    this.ipHits = new HitWindows(now, maxKeys);
  }

  /** Tracked keys (tests and diagnostics). */
  get size(): number {
    return this.failures.size + this.ipHits.size;
  }

  /** Counts a request from `ip`; false when the IP is over budget. */
  allowIp(ip: string | undefined): boolean {
    if (!ip) return true;
    if (this.ipHits.recent(ip, this.opts.ipWindowMs).length >= this.opts.ipLimit) return false;
    this.ipHits.add(ip, this.opts.ipWindowMs);
    return true;
  }

  /** Seconds until the username may try again, or 0. */
  lockedFor(username: string, surface: LoginSurface = 'admin'): number {
    const list = this.failures.recent(failureKey(username, surface), this.opts.windowMs);
    if (list.length < this.opts.maxFailures) return 0;
    return Math.ceil((list[0]! + this.opts.windowMs - this.now()) / 1000);
  }

  /** Records a failure; returns true if this failure triggered a lockout. */
  fail(username: string, surface: LoginSurface = 'admin'): boolean {
    return this.failures.add(failureKey(username, surface), this.opts.windowMs).length === this.opts.maxFailures;
  }

  succeed(username: string, surface: LoginSurface = 'admin') {
    this.failures.delete(failureKey(username, surface));
  }
}
