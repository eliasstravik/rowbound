/**
 * URL validation guard to prevent SSRF (Server-Side Request Forgery).
 *
 * Blocks requests to private/internal networks and non-HTTPS URLs
 * unless explicitly allowed.
 *
 * Known limitation: DNS rebinding attacks are NOT mitigated here. A hostname
 * could resolve to a public IP at check time and then re-resolve to a private
 * IP when the actual HTTP request is made. Mitigating this would require
 * resolving DNS before the check and pinning the IP for the request, which
 * adds latency and complexity. For now, this is accepted as a known gap.
 */
/**
 * Validate a URL before making an HTTP request.
 *
 * - Blocks non-HTTPS URLs by default (http://localhost and http://127.0.0.1
 *   are allowed for dev; set ROWBOUND_ALLOW_HTTP=true to allow all HTTP)
 * - Blocks private IP ranges to prevent SSRF to internal services
 * - Throws on invalid URLs
 */
export declare function validateUrl(url: string): void;
