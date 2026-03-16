import vm from "node:vm";
const FORBIDDEN_KEYWORDS = [
    "process",
    "require",
    "import",
    "globalThis",
    "global",
    "Function",
    "__proto__",
    "prototype",
    "constructor",
    "eval",
    "Reflect",
    "Proxy",
    "Symbol",
    "WeakRef",
    "this",
];
/**
 * Pre-check an expression for forbidden keywords as defense-in-depth.
 * Throws if the expression contains any keyword that could be used
 * to escape the vm sandbox.
 *
 * Exported so engine.ts can use the same check for transform expressions.
 */
export function preCheckExpression(expr) {
    for (const keyword of FORBIDDEN_KEYWORDS) {
        if (new RegExp(`\\b${keyword}\\b`).test(expr)) {
            throw new Error(`Expression contains forbidden keyword: "${keyword}"`);
        }
    }
}
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
export function evaluateCondition(expression, context) {
    if (!expression || expression.trim() === "") {
        return true;
    }
    preCheckExpression(expression);
    const rawSandbox = Object.create(null);
    rawSandbox.row = { ...context.row };
    rawSandbox.env = context.env;
    rawSandbox.results = context.results ?? {};
    const sandbox = vm.createContext(rawSandbox);
    try {
        const result = vm.runInContext(expression, sandbox, { timeout: 100 });
        return Boolean(result);
    }
    catch {
        // Timeout or syntax error — treat as false
        return false;
    }
}
