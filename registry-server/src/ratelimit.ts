// In-process sliding-window rate limiter for the Registry's externally
// triggered outbound manifest fetches (SECURITY_GUARDRAILS.md §"Rate limiting
// and abuse": expensive/public actions need abuse controls).
//
// Why this exists: register_agent fetches any caller-supplied manifest_url
// server-side, and get_manifest re-fetches a registered agent's URL when its
// cache goes stale. Without a cap, a malicious or buggy caller could hammer
// arbitrary third-party hosts through the registry as an unwitting request
// proxy, or spam registration attempts to burn egress/CPU.
//
// Deliberately simple for this project's scale: one process, one SQLite file,
// no shared infrastructure — so the limiter is in-memory, per-process, and
// best-effort under multi-process deployment (documented limitation, see
// registry-server/README.md). Time is injected so tests never sleep.

export class RateLimitError extends Error {}

export interface SlidingWindowOptions {
  /** Maximum events allowed inside any windowMs-long window. */
  maxEvents: number;
  windowMs: number;
  /** Injectable clock — defaults to Date.now. Tests override this to travel
   * through time instantly instead of sleeping. */
  now?: () => number;
}

export class SlidingWindowRateLimiter {
  private readonly events = new Map<string, number[]>();
  private readonly maxEvents: number;
  private readonly windowMs: number;
  now: () => number;

  constructor(options: SlidingWindowOptions) {
    this.maxEvents = options.maxEvents;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
  }

  /** Records one event under key, or throws RateLimitError if the sliding
   * window for that key is already full. Rejected attempts are NOT recorded
   * — a caller hammering a full key cannot extend their own lockout by
   * generating more events. */
  attempt(key: string): void {
    const nowMs = this.now();
    const windowStart = nowMs - this.windowMs;
    const timestamps = (this.events.get(key) ?? []).filter((t) => t > windowStart);
    if (timestamps.length >= this.maxEvents) {
      const oldest = timestamps[0];
      const retryInMs = oldest + this.windowMs - nowMs;
      throw new RateLimitError(
        `rate limit exceeded for ${key}: max ${this.maxEvents} per ${this.windowMs / 1000}s ` +
          `(retry in ~${Math.ceil(retryInMs / 1000)}s)`
      );
    }
    timestamps.push(nowMs);
    this.events.set(key, timestamps);

    // Opportunistic cleanup so abandoned keys don't grow the map forever.
    if (this.events.size > 10_000) {
      for (const [k, ts] of this.events) {
        if (!ts.some((t) => t > windowStart)) this.events.delete(k);
      }
    }
  }
}
