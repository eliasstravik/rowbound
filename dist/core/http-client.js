import { validateUrl } from "./url-guard.js";
/** Thrown when onError config specifies "stop_provider" */
export class StopProviderError extends Error {
    constructor(message = "Provider stopped due to error") {
        super(message);
        this.name = "StopProviderError";
    }
}
/**
 * Check if a status code is retryable (429 or 5xx).
 */
function isRetryable(status) {
    return status === 429 || (status >= 500 && status <= 599);
}
/**
 * Resolve the onError action for a given status code.
 * Checks the specific status first, then falls back to "default".
 */
function resolveErrorAction(onError, status) {
    if (!onError)
        return undefined;
    const statusKey = String(status);
    if (statusKey in onError) {
        return onError[statusKey];
    }
    if ("default" in onError) {
        return onError.default;
    }
    return undefined;
}
/**
 * Apply the resolved error action, returning an HttpResponse or throwing.
 */
function applyErrorAction(action, status) {
    if (action === undefined) {
        // No error handler — throw a generic error
        throw new Error(`HTTP request failed with status ${status}`);
    }
    if (action === "skip") {
        return null;
    }
    if (action === "stop_provider") {
        throw new StopProviderError(`Provider stopped: HTTP ${status}`);
    }
    if (typeof action === "object" && "write" in action) {
        return { status, data: action.write };
    }
    // Unknown action — treat as skip
    return null;
}
/**
 * Make an HTTP request with retry, rate limiting, and structured error handling.
 *
 * - Acquires a rate limiter token before each request attempt
 * - Retries on 429/5xx with exponential backoff
 * - Applies onError config for non-retryable errors or exhausted retries
 * - Respects AbortSignal for cancellation
 */
export async function httpRequest(options) {
    const { method, url, headers, body, retryAttempts = 0, retryBackoff, onError, rateLimiter, signal, } = options;
    // Validate URL to prevent SSRF
    validateUrl(url);
    const maxAttempts = retryAttempts + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Check abort before each attempt
        if (signal?.aborted) {
            throw new Error("Request aborted");
        }
        // Acquire rate limiter token
        if (rateLimiter) {
            await rateLimiter.acquire(signal);
        }
        let finalHeaders = headers;
        if (body !== undefined) {
            const hasContentType = headers &&
                Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
            if (!hasContentType) {
                finalHeaders = { ...headers, "Content-Type": "application/json" };
            }
        }
        let response;
        try {
            response = await fetch(url, {
                method,
                headers: finalHeaders,
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal,
            });
        }
        catch (_err) {
            // Network error or abort
            if (signal?.aborted) {
                throw new Error("Request aborted");
            }
            if (attempt < maxAttempts - 1) {
                await backoff(attempt, retryBackoff, signal);
                continue;
            }
            const action = resolveErrorAction(onError, 0);
            return applyErrorAction(action, 0);
        }
        // Success
        if (response.ok) {
            const data = await parseResponseBody(response);
            return { status: response.status, data };
        }
        // Retryable error
        if (isRetryable(response.status) && attempt < maxAttempts - 1) {
            await backoff(attempt, retryBackoff, signal);
            continue;
        }
        // Non-retryable error, or retries exhausted
        const action = resolveErrorAction(onError, response.status);
        return applyErrorAction(action, response.status);
    }
    // Should not be reached, but handle gracefully
    throw new Error("HTTP request failed: no attempts made");
}
/**
 * Backoff delay between retries. Respects AbortSignal to allow early exit.
 *
 * Strategies:
 * - "exponential" (default): 2^attempt * 100ms (100, 200, 400, 800, ...)
 * - "linear": (attempt + 1) * 200ms (200, 400, 600, ...)
 * - "fixed": constant 1000ms
 */
async function backoff(attempt, strategy, signal) {
    let delayMs;
    switch (strategy) {
        case "linear":
            delayMs = (attempt + 1) * 200;
            break;
        case "fixed":
            delayMs = 1000;
            break;
        default:
            delayMs = 2 ** attempt * 100;
            break;
    }
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(resolve, delayMs);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}
/**
 * Parse response body as JSON, falling back to text.
 */
async function parseResponseBody(response) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
        return response.json();
    }
    return response.text();
}
