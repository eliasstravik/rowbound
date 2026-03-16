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
 * Check if a hostname is an IPv6 private/reserved address.
 *
 * Blocked ranges:
 * - ::1              (loopback)
 * - fe80::/10        (link-local)
 * - fc00::/7         (unique local — fc00::/8 + fd00::/8)
 * - ::ffff:x.x.x.x  (IPv4-mapped IPv6 — delegates to IPv4 private check)
 */
function isPrivateIpv6(ip) {
    // Normalize: strip surrounding brackets (URLs use [::1] form)
    const raw = ip.replace(/^\[|\]$/g, "");
    const lower = raw.toLowerCase();
    // ::1 loopback
    if (lower === "::1")
        return true;
    // fe80::/10 link-local
    if (lower.startsWith("fe80:") || lower.startsWith("fe80%"))
        return true;
    // fc00::/7 — matches fc and fd prefixes
    if (lower.startsWith("fc") || lower.startsWith("fd"))
        return true;
    // ::ffff: IPv4-mapped IPv6 — two forms:
    // 1. Dotted-quad: ::ffff:10.0.0.1
    // 2. Hex-pair (URL-normalized): ::ffff:a00:1 (which is ::ffff:0a00:0001)
    const v4MappedDotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4MappedDotted) {
        return isPrivateIpv4(v4MappedDotted[1]);
    }
    // Hex-pair form: ::ffff:XXYY:ZZWW where XXYY and ZZWW are hex
    const v4MappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (v4MappedHex) {
        const hi = parseInt(v4MappedHex[1], 16);
        const lo = parseInt(v4MappedHex[2], 16);
        const a = (hi >>> 8) & 0xff;
        const b = hi & 0xff;
        const c = (lo >>> 8) & 0xff;
        const d = lo & 0xff;
        return isPrivateIpv4(`${a}.${b}.${c}.${d}`);
    }
    return false;
}
/**
 * Check if a string is a numeric (decimal) IP representation.
 * e.g. 2130706433 === 127.0.0.1, 0x7f000001, 0177.0.0.1
 *
 * Returns the dotted-quad string if it is, or null if not.
 */
function decodeNumericIp(hostname) {
    // Decimal integer form: e.g. 2130706433
    if (/^\d+$/.test(hostname)) {
        const num = Number(hostname);
        if (num >= 0 && num <= 0xffffffff) {
            const a = (num >>> 24) & 0xff;
            const b = (num >>> 16) & 0xff;
            const c = (num >>> 8) & 0xff;
            const d = num & 0xff;
            return `${a}.${b}.${c}.${d}`;
        }
    }
    // Hex form: 0x7f000001
    if (/^0x[0-9a-fA-F]+$/.test(hostname)) {
        const num = Number(hostname);
        if (num >= 0 && num <= 0xffffffff) {
            const a = (num >>> 24) & 0xff;
            const b = (num >>> 16) & 0xff;
            const c = (num >>> 8) & 0xff;
            const d = num & 0xff;
            return `${a}.${b}.${c}.${d}`;
        }
    }
    // Octal dotted form: 0177.0.0.1
    if (/^0\d*(\.\d+){0,3}$/.test(hostname)) {
        const parts = hostname.split(".").map((p) => parseInt(p, 8));
        if (parts.length === 4 &&
            parts.every((p) => !Number.isNaN(p) && p >= 0 && p <= 255)) {
            return parts.join(".");
        }
    }
    return null;
}
/**
 * Check if an IPv4 address falls within a private/reserved range.
 *
 * Blocked ranges:
 * - 0.0.0.0           (unspecified)
 * - 10.0.0.0/8        (private)
 * - 127.0.0.0/8       (loopback)
 * - 172.16.0.0/12     (private)
 * - 192.168.0.0/16    (private)
 * - 169.254.0.0/16    (link-local / cloud metadata)
 */
function isPrivateIpv4(ip) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 ||
        parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
        return false;
    }
    const [a, b] = parts;
    // 0.0.0.0
    if (a === 0 && parts[1] === 0 && parts[2] === 0 && parts[3] === 0)
        return true;
    // 10.0.0.0/8
    if (a === 10)
        return true;
    // 127.0.0.0/8 (full loopback range)
    if (a === 127)
        return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31)
        return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168)
        return true;
    // 169.254.0.0/16 (link-local, AWS metadata endpoint)
    if (a === 169 && b === 254)
        return true;
    return false;
}
/**
 * Check if a hostname resolves to a private/reserved IP.
 * Handles IPv4, IPv6, numeric/octal representations.
 */
function isPrivateIp(hostname) {
    // Check numeric/octal IP representations first
    const decoded = decodeNumericIp(hostname);
    if (decoded) {
        return isPrivateIpv4(decoded);
    }
    // IPv6 check (URL class strips brackets, but handle both)
    if (hostname.includes(":")) {
        return isPrivateIpv6(hostname);
    }
    // Standard IPv4 dotted-quad
    return isPrivateIpv4(hostname);
}
/**
 * Validate a URL before making an HTTP request.
 *
 * - Blocks non-HTTPS URLs by default (http://localhost and http://127.0.0.1
 *   are allowed for dev; set ROWBOUND_ALLOW_HTTP=true to allow all HTTP)
 * - Blocks private IP ranges to prevent SSRF to internal services
 * - Throws on invalid URLs
 */
export function validateUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new Error(`Invalid URL: ${url}`);
    }
    const allowHttp = process.env.ROWBOUND_ALLOW_HTTP === "true";
    const hostname = parsed.hostname;
    // Localhost dev exception: http://localhost and http://127.0.0.1 are allowed
    const isLocalhostDev = hostname === "localhost" || hostname === "127.0.0.1";
    // Protocol check
    if (parsed.protocol === "http:") {
        if (!isLocalhostDev && !allowHttp) {
            throw new Error(`Non-HTTPS URL blocked: ${url}. Set ROWBOUND_ALLOW_HTTP=true to allow HTTP.`);
        }
    }
    else if (parsed.protocol !== "https:") {
        throw new Error(`Unsupported protocol: ${parsed.protocol}`);
    }
    // Private IP check — block even for HTTPS (DNS rebinding protection).
    // Skip for explicit localhost dev addresses (127.0.0.1 / localhost) so
    // local development still works.
    if (!isLocalhostDev && isPrivateIp(hostname)) {
        throw new Error(`URL blocked: ${hostname} is a private IP address.`);
    }
}
