import { describe, expect, it, vi } from "vitest";
import { sortActionsByDependency } from "../action-deps.js";
import type { Action } from "../types.js";

describe("sortActionsByDependency", () => {
  it("returns same order when no dependencies exist", () => {
    const actions: Action[] = [
      {
        id: "a",
        type: "http",
        target: "col_a",
        method: "GET",
        url: "https://example.com",
        extract: "$",
      },
      {
        id: "b",
        type: "http",
        target: "col_b",
        method: "GET",
        url: "https://example.com",
        extract: "$",
      },
    ];
    const sorted = sortActionsByDependency(actions);
    expect(sorted.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("sorts a linear dependency chain: A → B → C", () => {
    const actions: Action[] = [
      {
        id: "c",
        type: "formula",
        target: "col_c",
        expression: "row.col_b.toUpperCase()",
      },
      {
        id: "a",
        type: "http",
        target: "col_a",
        method: "GET",
        url: "https://example.com",
        extract: "$",
      },
      {
        id: "b",
        type: "formula",
        target: "col_b",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional formula expression
        expression: "`${row.col_a} enriched`",
      },
    ];
    const sorted = sortActionsByDependency(actions);
    const ids = sorted.map((a) => a.id);
    // a must come before b, b must come before c
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"));
  });

  it("handles template {{row.X}} dependencies", () => {
    const actions: Action[] = [
      {
        id: "email",
        type: "http",
        target: "email",
        method: "GET",
        url: "https://api.com?domain={{row.domain_info}}",
        extract: "$.email",
      },
      {
        id: "domain",
        type: "http",
        target: "domain_info",
        method: "GET",
        url: "https://api.com/domain",
        extract: "$.domain",
      },
    ];
    const sorted = sortActionsByDependency(actions);
    expect(sorted[0]!.id).toBe("domain");
    expect(sorted[1]!.id).toBe("email");
  });

  it("handles when condition dependencies", () => {
    const actions: Action[] = [
      {
        id: "step2",
        type: "formula",
        target: "result",
        when: "row.validated === 'true'",
        expression: "'done'",
      },
      {
        id: "step1",
        type: "formula",
        target: "validated",
        expression: "'true'",
      },
    ];
    const sorted = sortActionsByDependency(actions);
    expect(sorted[0]!.id).toBe("step1");
    expect(sorted[1]!.id).toBe("step2");
  });

  it("detects circular dependencies and falls back to config order", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const actions: Action[] = [
      { id: "a", type: "formula", target: "col_a", expression: "row.col_b" },
      { id: "b", type: "formula", target: "col_b", expression: "row.col_a" },
    ];
    const sorted = sortActionsByDependency(actions);
    // Both are in the cycle — should appear (in config order as fallback)
    expect(sorted).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("circular dependency"),
    );
    warnSpy.mockRestore();
  });

  it("handles single action", () => {
    const actions: Action[] = [
      { id: "only", type: "formula", target: "out", expression: "'hello'" },
    ];
    expect(sortActionsByDependency(actions)).toEqual(actions);
  });

  it("handles empty array", () => {
    expect(sortActionsByDependency([])).toEqual([]);
  });

  it("handles AI action with prompt template dependencies", () => {
    const actions: Action[] = [
      {
        id: "ai_step",
        type: "ai",
        target: "summary",
        runtime: "claude",
        prompt: "Summarize {{row.company_name}}",
      },
      {
        id: "company",
        type: "http",
        target: "company_name",
        method: "GET",
        url: "https://api.com/company",
        extract: "$",
      },
    ];
    const sorted = sortActionsByDependency(actions);
    expect(sorted[0]!.id).toBe("company");
    expect(sorted[1]!.id).toBe("ai_step");
  });

  it("handles waterfall with template dependencies", () => {
    const actions: Action[] = [
      {
        id: "email",
        type: "waterfall",
        target: "email",
        providers: [
          {
            name: "p1",
            method: "GET",
            url: "https://api.com?name={{row.full_name}}",
            extract: "$.email",
          },
        ],
      },
      {
        id: "name",
        type: "formula",
        target: "full_name",
        expression: "'John Doe'",
      },
    ];
    const sorted = sortActionsByDependency(actions);
    expect(sorted[0]!.id).toBe("name");
    expect(sorted[1]!.id).toBe("email");
  });
});
