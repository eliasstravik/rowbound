import { extractValue } from "./extractor.js";
import { httpRequest } from "./http-client.js";
import { resolveObject, resolveTemplate, } from "./template.js";
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
export async function executeWaterfall(action, context, options = {}) {
    for (const provider of action.providers) {
        try {
            const resolvedUrl = resolveTemplate(provider.url, context, options.onMissing);
            const resolvedHeaders = provider.headers
                ? resolveObject(provider.headers, context, options.onMissing)
                : undefined;
            const resolvedBody = provider.body !== undefined
                ? resolveObject(provider.body, context, options.onMissing)
                : undefined;
            const response = await httpRequest({
                method: provider.method,
                url: resolvedUrl,
                headers: resolvedHeaders,
                body: resolvedBody,
                retryAttempts: options.retryAttempts,
                retryBackoff: options.retryBackoff,
                onError: provider.onError,
                rateLimiter: options.rateLimiter,
                signal: options.signal,
            });
            if (response === null) {
                // Request was skipped (e.g., onError: "skip") — try next provider
                continue;
            }
            const value = extractValue(response.data, provider.extract);
            if (value !== "") {
                return { value, provider: provider.name };
            }
            // Empty extraction — try next provider
        }
        catch (error) {
            // Propagate abort errors — do not try remaining providers
            if (error instanceof Error && error.message === "Request aborted") {
                throw error;
            }
        }
    }
    return null;
}
