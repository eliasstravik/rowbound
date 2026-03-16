import type { ExecutionContext } from "./types.js";
/**
 * Callback invoked when a template variable resolves to undefined.
 * @param source - "row" or "env"
 * @param key - the variable name that was missing
 */
export type OnMissingCallback = (source: string, key: string) => void;
/**
 * Resolve template strings like {{row.email}} and {{env.API_KEY}}.
 * Missing variables resolve to empty string.
 *
 * When `onMissing` is provided, it is called for every variable that
 * resolves to `undefined` in the given context.
 */
export declare function resolveTemplate(template: string, context: ExecutionContext, onMissing?: OnMissingCallback): string;
/**
 * Resolve template strings with an escape function applied to each resolved value.
 *
 * Used for shell contexts where row/env values must be sanitized before
 * interpolation (e.g., shell-escaping to prevent command injection).
 * The escape function is applied to each resolved placeholder value,
 * NOT to static parts of the template.
 */
export declare function resolveTemplateEscaped(template: string, context: ExecutionContext, escapeFn: (value: string) => string, onMissing?: OnMissingCallback): string;
/**
 * Recursively resolve templates in an object/array/string.
 * - Strings: resolve template placeholders
 * - Arrays: resolve each element
 * - Objects: resolve each value (keys are not resolved)
 * - Other types: pass through unchanged
 */
export declare function resolveObject(obj: unknown, context: ExecutionContext, onMissing?: OnMissingCallback, depth?: number): unknown;
