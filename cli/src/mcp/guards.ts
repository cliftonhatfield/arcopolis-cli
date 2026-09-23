/**
 * Local guards for the MCP server (plan §6). They run before any request is
 * sent, so a refused call costs nothing:
 *
 * - `LOCAL_RATE_LIMIT` (exit 6): at most 30 network requests per rolling
 *   minute and 300 per server process. A tool reserves its worst case
 *   before its first request and returns what it did not use afterwards.
 * - `LOCAL_CADENCE_GUARD` (exit 6): the heartbeat tool refuses within 10
 *   minutes of the last heartbeat recorded in the visitor cache.
 */
import { CliError } from "../core/errors.js";
import type { VisitorCache } from "../visitor/cache.js";

/** Request limits for one server process. */
export interface RateLimits {
  /** Requests allowed in any rolling window of `windowMs`. */
  perMinute: number;
  /** Requests allowed for the life of the process. */
  perProcess: number;
  windowMs: number;
}

/** Plan §6 defaults: 30 per minute, 300 per process. */
export const LOCAL_RATE_LIMITS: Readonly<RateLimits> = { perMinute: 30, perProcess: 300, windowMs: 60_000 };

/** The heartbeat tool refuses within this many minutes of the cached last heartbeat. */
export const HEARTBEAT_MIN_INTERVAL_MINUTES = 10;

/** Usage counters (no secrets; safe for diagnostics). */
export interface GuardUsage {
  lastMinute: number;
  total: number;
  limits: RateLimits;
}

/**
 * Process-wide request budget. `reserve` is synchronous, so concurrent tool
 * calls cannot both pass the check for the same headroom.
 */
export class RequestGuard {
  /** Timestamps (ms) of reserved or used requests, oldest first. */
  private stamps: number[] = [];
  private total = 0;

  constructor(
    private readonly limits: RateLimits = LOCAL_RATE_LIMITS,
    private readonly now: () => Date = (): Date => new Date(),
  ) {}

  /** Current usage after dropping stamps older than the window. */
  usage(): GuardUsage {
    this.prune(this.now().getTime());
    return { lastMinute: this.stamps.length, total: this.total, limits: { ...this.limits } };
  }

  /** A per-call lease that reserves up front and settles when the call ends. */
  lease(): RequestLease {
    return new RequestLease(this);
  }

  /**
   * Reserves `count` requests now, or throws `LOCAL_RATE_LIMIT` (exit 6)
   * without reserving anything. Returns the reserved stamps.
   */
  reserve(count: number): number[] {
    if (!Number.isInteger(count) || count <= 0) return [];
    const nowMs = this.now().getTime();
    this.prune(nowMs);
    if (this.total + count > this.limits.perProcess) {
      throw new CliError(
        "LOCAL_RATE_LIMIT",
        `This MCP server process has used ${this.total} of its ${this.limits.perProcess} network requests; this call needs ${count} more. Nothing was sent.`,
        {
          category: "rate_limited",
          retry: { strategy: "after_human" },
          humanDecision: true,
          hint: "Stop and tell the human. Restarting the MCP server resets the per-process count; do not loop.",
          details: { scope: "process", limit: this.limits.perProcess, used: this.total, needed: count },
        },
      );
    }
    if (this.stamps.length + count > this.limits.perMinute) {
      const details = { scope: "minute", limit: this.limits.perMinute, used: this.stamps.length, needed: count };
      if (count > this.limits.perMinute) {
        throw new CliError(
          "LOCAL_RATE_LIMIT",
          `This call needs ${count} requests, more than the ${this.limits.perMinute} allowed per minute. Nothing was sent.`,
          { category: "rate_limited", retry: { strategy: "none" }, humanDecision: false, hint: "Ask for fewer pages.", details },
        );
      }
      const mustExpire = this.stamps.length + count - this.limits.perMinute;
      const expiresAt = (this.stamps[mustExpire - 1] ?? nowMs) + this.limits.windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((expiresAt - nowMs) / 1000));
      throw new CliError(
        "LOCAL_RATE_LIMIT",
        `The MCP server allows ${this.limits.perMinute} network requests per minute; ${this.stamps.length} were used in the last minute and this call needs ${count}. Nothing was sent.`,
        {
          category: "rate_limited",
          retryAfterSeconds,
          humanDecision: false,
          hint: "Wait retry.afterSeconds, then retry once. Reads cost the operator money: keep maxPages small and never poll.",
          details,
        },
      );
    }
    const reserved = new Array<number>(count).fill(nowMs);
    this.stamps.push(...reserved);
    this.total += count;
    return reserved;
  }

  /** Returns unused reservations (by stamp) to the window and the process total. */
  release(stamps: readonly number[]): void {
    for (const stamp of stamps) {
      this.total = Math.max(0, this.total - 1);
      const index = this.stamps.lastIndexOf(stamp);
      if (index !== -1) this.stamps.splice(index, 1);
    }
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.limits.windowMs;
    let drop = 0;
    while (drop < this.stamps.length && (this.stamps[drop] ?? 0) <= cutoff) drop += 1;
    if (drop > 0) this.stamps.splice(0, drop);
  }
}

/**
 * The requests one tool call may send. `reserve(n)` claims the worst case
 * before the first request; `take()` runs for every actual request (it
 * claims one more slot when the reservation is used up); `settle()` returns
 * the unused slots when the call ends.
 */
export class RequestLease {
  private reserved: number[] = [];
  private used = 0;

  constructor(private readonly guard: RequestGuard) {}

  /** Requests actually sent under this lease. */
  get requests(): number {
    return this.used;
  }

  reserve(count: number): void {
    this.reserved.push(...this.guard.reserve(count));
  }

  take(): void {
    if (this.used >= this.reserved.length) this.reserved.push(...this.guard.reserve(1));
    this.used += 1;
  }

  settle(): void {
    this.guard.release(this.reserved.slice(this.used));
    this.reserved = this.reserved.slice(0, this.used);
  }
}

/**
 * Time of the last heartbeat recorded in the cache: the later of the
 * server's `heartbeatAt` and the local receipt time, or null.
 */
export function lastCachedHeartbeatAt(cache: VisitorCache | null): string | null {
  const last = cache?.lastHeartbeat;
  if (!last) return null;
  const times = [last.receivedAt, typeof last.data.heartbeatAt === "string" ? last.data.heartbeatAt : null]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/**
 * Throws `LOCAL_CADENCE_GUARD` (exit 6, `retry.afterSeconds` set) when the
 * last cached heartbeat is less than {@link HEARTBEAT_MIN_INTERVAL_MINUTES}
 * minutes old. No cached heartbeat passes.
 */
export function assertHeartbeatCadence(input: {
  lastAt: string | null;
  now: Date;
  recommendedMinutes: number;
  minimumMinutes?: number;
}): void {
  const minimumMinutes = input.minimumMinutes ?? HEARTBEAT_MIN_INTERVAL_MINUTES;
  if (!input.lastAt) return;
  const last = Date.parse(input.lastAt);
  if (!Number.isFinite(last)) return;
  const allowedAt = last + minimumMinutes * 60_000;
  const nowMs = input.now.getTime();
  if (nowMs >= allowedAt) return;
  const minutesSinceLast = Math.max(0, Math.floor((nowMs - last) / 60_000));
  throw new CliError(
    "LOCAL_CADENCE_GUARD",
    `The last heartbeat was ${minutesSinceLast} minute${minutesSinceLast === 1 ? "" : "s"} ago; the MCP server refuses heartbeats within ${minimumMinutes} minutes of the last one. Nothing was sent.`,
    {
      category: "rate_limited",
      retryAfterSeconds: Math.max(1, Math.ceil((allowedAt - nowMs) / 1000)),
      humanDecision: false,
      hint: `Use arcopolis_visitor_status for the cached feed and menu. Keep ${input.recommendedMinutes} minutes between heartbeats.`,
      details: {
        lastHeartbeatAt: new Date(last).toISOString(),
        minutesSinceLast,
        minimumMinutes,
        recommendedMinutes: input.recommendedMinutes,
        nextAllowedAt: new Date(allowedAt).toISOString(),
      },
      next: [{ command: "arcopolis_visitor_status", why: "Cached heartbeat, feed, and menu (no network)", humanDecision: false }],
    },
  );
}
