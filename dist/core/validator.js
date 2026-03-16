import vm from "node:vm";
import { JSONPath } from "jsonpath-plus";
/** Maximum recommended config size in bytes (Developer Metadata limit is 30K). */
const CONFIG_SIZE_WARN = 25_000;
/** Allowed action types. */
const VALID_ACTION_TYPES = new Set(["http", "waterfall", "transform", "exec"]);
/** Known retry backoff strategies. */
const KNOWN_BACKOFF = new Set(["exponential", "linear", "fixed"]);
/** Standard HTTP methods. */
const KNOWN_HTTP_METHODS = new Set([
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
]);
/**
 * Regex for valid template placeholders: {{row.xxx}} or {{env.XXX}}.
 * Invalid patterns are anything inside {{ }} that does NOT match this form.
 */
const VALID_TEMPLATE_REGEX = /^\{\{(row|env)\.[^}]+\}\}$/;
/**
 * Finds all {{...}} patterns in a string and returns any that are invalid.
 */
function findInvalidTemplates(value) {
    const TEMPLATE_REGEX = /\{\{[^}]*\}\}/g;
    const invalid = [];
    for (const match of value.matchAll(TEMPLATE_REGEX)) {
        if (!VALID_TEMPLATE_REGEX.test(match[0])) {
            invalid.push(match[0]);
        }
    }
    return invalid;
}
/**
 * Recursively collect all string values from a JSON-like structure.
 */
function collectStrings(obj) {
    if (typeof obj === "string")
        return [obj];
    if (Array.isArray(obj))
        return obj.flatMap(collectStrings);
    if (obj !== null && typeof obj === "object") {
        return Object.values(obj).flatMap(collectStrings);
    }
    return [];
}
/**
 * Check whether a `when` expression can be parsed as valid JavaScript.
 * Uses vm.compileFunction which only compiles (no callable Function object).
 */
function isParseableExpression(expression) {
    try {
        vm.compileFunction(`"use strict"; return (${expression});`);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Check whether a JSONPath expression is syntactically valid.
 */
function isValidJsonPath(expression) {
    try {
        JSONPath({ path: expression, json: {}, eval: false });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Validate template strings in url, headers, and body of an action-like object.
 */
function validateTemplates(label, obj, errors) {
    // Check url
    if (obj.url) {
        const invalid = findInvalidTemplates(obj.url);
        for (const t of invalid) {
            errors.push(`${label}: invalid template "${t}" in url — must be {{row.x}} or {{env.X}}`);
        }
    }
    // Check header values
    if (obj.headers) {
        for (const [headerKey, headerVal] of Object.entries(obj.headers)) {
            const invalid = findInvalidTemplates(headerVal);
            for (const t of invalid) {
                errors.push(`${label}: invalid template "${t}" in header "${headerKey}"`);
            }
        }
    }
    // Check body (recursively collect strings)
    if (obj.body !== undefined) {
        const bodyStrings = collectStrings(obj.body);
        for (const s of bodyStrings) {
            const invalid = findInvalidTemplates(s);
            for (const t of invalid) {
                errors.push(`${label}: invalid template "${t}" in body`);
            }
        }
    }
}
/**
 * Validate an entire PipelineConfig, returning errors and warnings.
 */
export function validateConfig(config) {
    const errors = [];
    const warnings = [];
    // 1. Version check
    if (config.version !== "1" && config.version !== "2") {
        errors.push(`Invalid version "${config.version}" (expected "1" or "2")`);
    }
    // 2. Unique action IDs
    const ids = config.actions.map((s) => s.id);
    const seen = new Set();
    const duplicates = new Set();
    for (const id of ids) {
        if (seen.has(id)) {
            duplicates.add(id);
        }
        seen.add(id);
    }
    if (duplicates.size > 0) {
        errors.push(`Duplicate action IDs: ${[...duplicates].join(", ")}`);
    }
    // 3 & 4. Per-action validation
    for (const action of config.actions) {
        const label = `Action "${action.id}"`;
        // Common required fields
        if (!action.id) {
            errors.push("An action is missing the 'id' field");
        }
        if (!action.type) {
            errors.push(`${label}: missing 'type' field`);
        }
        if (!action.target) {
            errors.push(`${label}: missing 'target' field`);
        }
        // Valid action type
        if (action.type && !VALID_ACTION_TYPES.has(action.type)) {
            errors.push(`${label}: invalid type "${action.type}"`);
        }
        // 6. Parseable conditions
        if (action.when !== undefined) {
            if (!isParseableExpression(action.when)) {
                errors.push(`${label}: 'when' expression has invalid syntax: "${action.when}"`);
            }
        }
        // Type-specific validation
        if (action.type === "http") {
            const httpAction = action;
            if (!httpAction.method) {
                errors.push(`${label}: http action missing 'method'`);
            }
            else if (!KNOWN_HTTP_METHODS.has(httpAction.method.toUpperCase())) {
                warnings.push(`${label}: HTTP method "${httpAction.method}" is not a standard method (expected one of: ${[...KNOWN_HTTP_METHODS].join(", ")})`);
            }
            if (!httpAction.url) {
                errors.push(`${label}: http action missing 'url'`);
            }
            if (!httpAction.extract) {
                errors.push(`${label}: http action missing 'extract'`);
            }
            // 5. Template validation
            validateTemplates(label, httpAction, errors);
            // 7. JSONPath validation
            if (httpAction.extract && !isValidJsonPath(httpAction.extract)) {
                errors.push(`${label}: invalid JSONPath in 'extract': "${httpAction.extract}"`);
            }
        }
        else if (action.type === "waterfall") {
            const waterfallAction = action;
            if (!waterfallAction.providers ||
                !Array.isArray(waterfallAction.providers) ||
                waterfallAction.providers.length === 0) {
                errors.push(`${label}: waterfall action must have a non-empty 'providers' array`);
            }
            else {
                for (let i = 0; i < waterfallAction.providers.length; i++) {
                    const provider = waterfallAction.providers[i];
                    const pLabel = `${label} provider[${i}]`;
                    if (!provider.name) {
                        errors.push(`${pLabel}: missing 'name'`);
                    }
                    if (!provider.method) {
                        errors.push(`${pLabel}: missing 'method'`);
                    }
                    if (!provider.url) {
                        errors.push(`${pLabel}: missing 'url'`);
                    }
                    if (!provider.extract) {
                        errors.push(`${pLabel}: missing 'extract'`);
                    }
                    // Template validation on each provider
                    validateTemplates(provider.name ? `${label} provider "${provider.name}"` : pLabel, provider, errors);
                    // JSONPath validation on each provider
                    if (provider.extract && !isValidJsonPath(provider.extract)) {
                        errors.push(`${provider.name ? `${label} provider "${provider.name}"` : pLabel}: invalid JSONPath in 'extract': "${provider.extract}"`);
                    }
                }
            }
        }
        else if (action.type === "transform") {
            const transformAction = action;
            if (!transformAction.expression) {
                errors.push(`${label}: transform action missing 'expression'`);
            }
        }
        else if (action.type === "exec") {
            const execAction = action;
            if (!execAction.command) {
                errors.push(`${label}: exec action missing 'command'`);
            }
            // Template validation in command
            if (execAction.command) {
                const invalid = findInvalidTemplates(execAction.command);
                for (const t of invalid) {
                    errors.push(`${label}: invalid template "${t}" in command — must be {{row.x}} or {{env.X}}`);
                }
            }
            // Validate timeout if present
            if (execAction.timeout !== undefined &&
                (typeof execAction.timeout !== "number" || execAction.timeout <= 0)) {
                errors.push(`${label}: exec action 'timeout' must be a positive number (got ${JSON.stringify(execAction.timeout)})`);
            }
            // JSONPath validation on extract if present
            if (execAction.extract && !isValidJsonPath(execAction.extract)) {
                errors.push(`${label}: invalid JSONPath in 'extract': "${execAction.extract}"`);
            }
        }
    }
    // 8. Config size warning
    const serialized = JSON.stringify(config);
    if (serialized.length > CONFIG_SIZE_WARN) {
        warnings.push(`Config size is ${serialized.length} bytes — approaching the 30K Developer Metadata limit`);
    }
    // 9. Settings validation
    if (config.settings) {
        const { concurrency, rateLimit, retryAttempts, retryBackoff } = config.settings;
        if (typeof concurrency !== "number" || concurrency <= 0) {
            errors.push(`settings.concurrency must be > 0 (got ${JSON.stringify(concurrency)})`);
        }
        if (typeof rateLimit !== "number" || rateLimit < 0) {
            errors.push(`settings.rateLimit must be >= 0 (got ${JSON.stringify(rateLimit)})`);
        }
        if (typeof retryAttempts !== "number" || retryAttempts < 0) {
            errors.push(`settings.retryAttempts must be >= 0 (got ${JSON.stringify(retryAttempts)})`);
        }
        if (typeof retryBackoff === "string" && !KNOWN_BACKOFF.has(retryBackoff)) {
            warnings.push(`settings.retryBackoff "${retryBackoff}" is not a known strategy (known: ${[...KNOWN_BACKOFF].join(", ")})`);
        }
    }
    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}
