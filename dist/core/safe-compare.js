import { timingSafeEqual } from "node:crypto";
/**
 * Constant-time string comparison to prevent timing attacks on secret tokens.
 *
 * Uses crypto.timingSafeEqual under the hood. When lengths differ, we still
 * compare against a same-length dummy to avoid leaking length information
 * through early return timing.
 */
export function safeCompare(a, b) {
    const bufA = Buffer.from(a, "utf-8");
    const bufB = Buffer.from(b, "utf-8");
    if (bufA.length !== bufB.length) {
        // Compare bufA against itself to burn the same amount of time,
        // then return false. This avoids leaking length information.
        timingSafeEqual(bufA, bufA);
        return false;
    }
    return timingSafeEqual(bufA, bufB);
}
