/**
 * Token bucket rate limiter.
 *
 * Refills tokens based on elapsed time, with max capacity equal to
 * tokensPerSecond. Used globally across all HTTP requests.
 */
export declare class RateLimiter {
    private readonly tokensPerSecond;
    private tokens;
    private readonly maxTokens;
    private lastRefill;
    private queue;
    constructor(tokensPerSecond: number);
    /**
     * Acquire a single token. Resolves immediately if a token is available,
     * otherwise waits until one is refilled. Respects AbortSignal for early exit.
     *
     * Serialized via a promise chain to prevent race conditions when
     * multiple callers invoke acquire() concurrently.
     */
    acquire(signal?: AbortSignal): Promise<void>;
    private _acquire;
    private refill;
    private sleep;
}
