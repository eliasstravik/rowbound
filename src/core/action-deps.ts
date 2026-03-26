import type { Action, AiAction } from "./types.js";

/**
 * Extract column references from template strings: {{row.columnName}}
 */
function extractTemplateRefs(text: string | undefined): Set<string> {
  const refs = new Set<string>();
  if (!text) return refs;
  for (const m of text.matchAll(/\{\{row\.([^}]+)\}\}/g)) {
    refs.add(m[1]!);
  }
  return refs;
}

/**
 * Extract column references from JS expressions: row.columnName
 */
function extractExpressionRefs(expr: string | undefined): Set<string> {
  const refs = new Set<string>();
  if (!expr) return refs;
  for (const m of expr.matchAll(/row\.(\w+)/g)) {
    refs.add(m[1]!);
  }
  return refs;
}

/**
 * Get all column references for an action (what columns it reads).
 */
function getActionDependencies(action: Action): Set<string> {
  const deps = new Set<string>();

  // when condition (JS expression)
  for (const ref of extractExpressionRefs(action.when)) {
    deps.add(ref);
  }

  if (action.type === "http") {
    for (const ref of extractTemplateRefs(action.url)) deps.add(ref);
    if (action.headers) {
      for (const v of Object.values(action.headers)) {
        for (const ref of extractTemplateRefs(v)) deps.add(ref);
      }
    }
    // Scan body for refs — handles string, object, and array bodies
    if (action.body !== undefined) {
      const bodyStr =
        typeof action.body === "string"
          ? action.body
          : JSON.stringify(action.body);
      for (const ref of extractTemplateRefs(bodyStr)) deps.add(ref);
    }
  } else if (action.type === "waterfall") {
    for (const p of action.providers) {
      for (const ref of extractTemplateRefs(p.url)) deps.add(ref);
      if (p.headers) {
        for (const v of Object.values(p.headers)) {
          for (const ref of extractTemplateRefs(v)) deps.add(ref);
        }
      }
    }
  } else if (action.type === "formula") {
    for (const ref of extractExpressionRefs(action.expression)) deps.add(ref);
  } else if (action.type === "exec") {
    for (const ref of extractTemplateRefs(action.command)) deps.add(ref);
  } else if (action.type === "lookup") {
    for (const ref of extractTemplateRefs(action.matchValue)) deps.add(ref);
  } else if (action.type === "write") {
    for (const v of Object.values(action.columns)) {
      for (const ref of extractTemplateRefs(v)) deps.add(ref);
    }
    if (action.expand) {
      for (const ref of extractTemplateRefs(action.expand)) deps.add(ref);
    }
  } else if (action.type === "script") {
    if (action.args) {
      for (const arg of action.args) {
        for (const ref of extractTemplateRefs(arg)) deps.add(ref);
      }
    }
  } else if (action.type === "ai") {
    for (const ref of extractTemplateRefs((action as AiAction).prompt)) {
      deps.add(ref);
    }
  }

  return deps;
}

/**
 * Get the column(s) an action produces.
 */
function getActionTargets(action: Action): Set<string> {
  const targets = new Set<string>();
  targets.add(action.target);

  if (action.type === "ai" && (action as AiAction).outputs) {
    for (const col of Object.keys((action as AiAction).outputs!)) {
      targets.add(col);
    }
  }

  return targets;
}

/**
 * Topologically sort actions based on their column dependencies.
 * Falls back to config order for cyclic groups with a console warning.
 *
 * Returns the sorted action array (may be same order if no dependencies).
 */
export function sortActionsByDependency(actions: Action[]): Action[] {
  if (actions.length <= 1) return actions;

  // Build a map of target column -> action index
  const targetToIndex = new Map<string, number>();
  for (let i = 0; i < actions.length; i++) {
    for (const t of getActionTargets(actions[i]!)) {
      targetToIndex.set(t, i);
    }
  }

  // Build adjacency: edges[i] = set of action indices that action i depends on
  const deps: Set<number>[] = actions.map(() => new Set<number>());
  for (let i = 0; i < actions.length; i++) {
    for (const dep of getActionDependencies(actions[i]!)) {
      const depIndex = targetToIndex.get(dep);
      if (depIndex !== undefined && depIndex !== i) {
        deps[i]!.add(depIndex);
      }
    }
  }

  // Build reverse edges and in-degree for Kahn's algorithm
  const reverseEdges: Set<number>[] = actions.map(() => new Set<number>());
  const inDeg = new Array(actions.length).fill(0) as number[];
  for (let i = 0; i < actions.length; i++) {
    for (const dep of deps[i]!) {
      reverseEdges[dep]!.add(i);
      inDeg[i]!++;
    }
  }

  const queue: number[] = [];
  for (let i = 0; i < actions.length; i++) {
    if (inDeg[i] === 0) queue.push(i);
  }

  const sorted: number[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const dependent of reverseEdges[node]!) {
      inDeg[dependent]!--;
      if (inDeg[dependent] === 0) queue.push(dependent);
    }
  }

  if (sorted.length < actions.length) {
    // Cycle detected — append remaining in config order with warning
    const sortedSet = new Set(sorted);
    const cyclic: number[] = [];
    for (let i = 0; i < actions.length; i++) {
      if (!sortedSet.has(i)) cyclic.push(i);
    }
    const cyclicIds = cyclic.map((idx) => actions[idx]!.id).join(", ");
    console.warn(
      `Warning: circular dependency detected among actions [${cyclicIds}]. Using config order for these actions.`,
    );
    sorted.push(...cyclic);
  }

  return sorted.map((idx) => actions[idx]!);
}
