/**
 * Constant-time string comparison to prevent timing attacks on secret tokens.
 *
 * Uses crypto.timingSafeEqual under the hood. When lengths differ, we still
 * compare against a same-length dummy to avoid leaking length information
 * through early return timing.
 */
export declare function safeCompare(a: string, b: string): boolean;
