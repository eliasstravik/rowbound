import vm from "node:vm";
import type { ExecutionContext } from "./types.js";

/**
 * Expand {{column}} / {{row.column}} / {{env.VAR}} placeholders in a
 * condition expression into quoted JS string literals so users can write
 * e.g. `{{domain}} !== ''` instead of `row.domain !== ''`.
 */
const TEMPLATE_REGEX = /\{\{(?:(row|env)\.)?([^}]+)\}\}/g;
function expandTemplates(
  expression: string,
  context: ExecutionContext,
): string {
  return expression.replace(
    TEMPLATE_REGEX,
    (_match, rawSource: string | undefined, key: string) => {
      const source = rawSource ?? "row";
      let value: string | undefined;
      if (source === "row") {
        value = context.row[key];
      } else if (source === "env") {
        value = context.env[key];
      }
      const safe = (value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      return `'${safe}'`;
    },
  );
}

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
 * Exported so engine.ts can use the same check for formula expressions.
 */
export function preCheckExpression(expr: string): void {
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
export function evaluateCondition(
  expression: string | undefined,
  context: ExecutionContext,
): boolean {
  if (!expression || expression.trim() === "") {
    return true;
  }

  const expanded = expandTemplates(expression, context);

  preCheckExpression(expanded);

  const rawSandbox = Object.create(null) as Record<string, unknown>;
  rawSandbox.row = { ...context.row };
  rawSandbox.env = context.env;
  rawSandbox.results = context.results ?? {};
  const sandbox = vm.createContext(rawSandbox);

  try {
    const result = vm.runInContext(expanded, sandbox, { timeout: 100 });
    return Boolean(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    // Syntax errors are thrown — a broken condition should not silently skip.
    if (msg.includes("SyntaxError") || msg.includes("Unexpected")) {
      throw new Error(
        `Condition evaluation failed for "${expression}": ${msg}`,
      );
    }

    // Runtime errors (TypeError on undefined access, etc.) log a warning
    // and return false for backward compatibility with existing pipelines.
    console.warn(
      `Warning: condition "${expression}" threw at runtime: ${msg} — treating as false`,
    );
    return false;
  }
}
