import type { RateLimiter } from "./rate-limiter.js";
import { type OnMissingCallback } from "./template.js";
import type { ExecutionContext, WaterfallAction } from "./types.js";
export interface WaterfallResult {
    value: string;
    provider: string;
}
/**
 * Execute a waterfall action: try each provider in order until one succeeds.
 *
 * For each provider:
 * 1. Resolve templates in url, headers, body
 * 2. Make HTTP request
 * 3. Extract value from response
 * 4. Return first non-empty result
 *
 * StopProviderError and other errors cause the provider to be skipped.
 * Returns null if no provider produces a value.
 */
export declare function executeWaterfall(action: WaterfallAction, context: ExecutionContext, options?: {
    rateLimiter?: RateLimiter;
    retryAttempts?: number;
    retryBackoff?: string;
    signal?: AbortSignal;
    onMissing?: OnMissingCallback;
}): Promise<WaterfallResult | null>;
