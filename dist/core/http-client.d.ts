import type { RateLimiter } from "./rate-limiter.js";
import type { OnErrorConfig } from "./types.js";
/** Options for httpRequest */
export interface HttpRequestOptions {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
    retryAttempts?: number;
    retryBackoff?: string;
    onError?: OnErrorConfig;
    rateLimiter?: RateLimiter;
    signal?: AbortSignal;
}
/** Successful HTTP response */
export interface HttpResponse {
    status: number;
    data: unknown;
}
/** Thrown when onError config specifies "stop_provider" */
export declare class StopProviderError extends Error {
    constructor(message?: string);
}
/**
 * Make an HTTP request with retry, rate limiting, and structured error handling.
 *
 * - Acquires a rate limiter token before each request attempt
 * - Retries on 429/5xx with exponential backoff
 * - Applies onError config for non-retryable errors or exhausted retries
 * - Respects AbortSignal for cancellation
 */
export declare function httpRequest(options: HttpRequestOptions): Promise<HttpResponse | null>;
