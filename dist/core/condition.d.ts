import type { ExecutionContext } from "./types.js";
/**
 * Pre-check an expression for forbidden keywords as defense-in-depth.
 * Throws if the expression contains any keyword that could be used
 * to escape the vm sandbox.
 *
 * Exported so engine.ts can use the same check for transform expressions.
 */
export declare function preCheckExpression(expr: string): void;
/**
 * Evaluate a JavaScript expression in a sandboxed context.
 *
 * WARNING: Node.js vm module is NOT a security boundary. The pre-check
 * and Object.create(null) sandbox are defense-in-depth measures only.
 * Do not rely on this for untrusted code execution.
 *
 * - Empty/undefined expression returns true (no condition = always run)
 * - Sandbox exposes: row, env, results
 * - Uses Object.create(null) to sever prototype chain (prevents escape via
 *   this.constructor.constructor('return process')())
 * - Pre-checks for forbidden keywords (process, require, import, etc.)
 * - Times out after 100ms to prevent infinite loops
 * - Result is coerced to boolean
 */
export declare function evaluateCondition(expression: string | undefined, context: ExecutionContext): boolean;
