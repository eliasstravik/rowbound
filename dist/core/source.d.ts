import type { RateLimiter } from "./rate-limiter.js";
import type { Adapter, ScriptDef, SheetRef, Source, SourceResult, WebhookSource } from "./types.js";
export interface SourceOptions {
    adapter: Adapter;
    ref: SheetRef;
    env: Record<string, string>;
    dryRun?: boolean;
    signal?: AbortSignal;
    /** Resolve a script name to its definition. Required for script sources. */
    resolveScript?: (name: string) => ScriptDef | null;
    rateLimiter?: RateLimiter;
    retryAttempts?: number;
    retryBackoff?: string;
}
/**
 * Execute a source and create rows in the target sheet.
 */
export declare function executeSource(source: Source, options: SourceOptions): Promise<SourceResult>;
/**
 * Execute a webhook source with pre-parsed payload data.
 * Called from the watch webhook handler when a POST is received.
 */
export declare function executeWebhookSource(source: WebhookSource, payload: unknown, options: SourceOptions): Promise<SourceResult>;
