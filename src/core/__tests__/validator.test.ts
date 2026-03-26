import { describe, expect, it } from "vitest";
import type { PipelineConfig } from "../types.js";
import { validateConfig } from "../validator.js";

/** Helper: build a minimal valid config. */
function validConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
  return {
    version: "1",
    actions: [
      {
        id: "enrich_email",
        type: "http",
        target: "Email",
        method: "GET",
        url: "https://api.example.com/lookup?domain={{row.domain}}",
        extract: "$.email",
      },
    ],
    settings: {
      concurrency: 5,
      rateLimit: 10,
      retryAttempts: 3,
      retryBackoff: "exponential",
    },
    ...overrides,
  };
}

describe("validateConfig", () => {
  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("passes for a valid config", () => {
    const result = validateConfig(validConfig());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("passes for a config with multiple valid action types", () => {
    const config = validConfig({
      actions: [
        {
          id: "action1",
          type: "http",
          target: "Col1",
          method: "GET",
          url: "https://api.example.com/{{row.id}}",
          extract: "$.value",
        },
        {
          id: "action2",
          type: "waterfall",
          target: "Col2",
          providers: [
            {
              name: "provider_a",
              method: "GET",
              url: "https://a.example.com/{{row.id}}",
              extract: "$.result",
            },
            {
              name: "provider_b",
              method: "POST",
              url: "https://b.example.com/",
              extract: "$.data",
            },
          ],
        },
        {
          id: "action3",
          type: "formula",
          target: "Col3",
          expression: "row.first + ' ' + row.last",
        },
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("passes for a config with no actions", () => {
    const result = validateConfig(validConfig({ actions: [] }));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Version
  // -------------------------------------------------------------------------

  it("fails when version is not '1' or '2'", () => {
    const result = validateConfig(validConfig({ version: "99" }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('Invalid version "99"'),
    );
  });

  it("accepts version '2'", () => {
    const result = validateConfig(validConfig({ version: "2" }));
    expect(result.valid).toBe(true);
  });

  it("fails when version is empty string", () => {
    const result = validateConfig(validConfig({ version: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("Invalid version"),
    );
  });

  // -------------------------------------------------------------------------
  // Duplicate action IDs
  // -------------------------------------------------------------------------

  it("detects duplicate action IDs", () => {
    const config = validConfig({
      actions: [
        {
          id: "dup",
          type: "http",
          target: "A",
          method: "GET",
          url: "https://a.com",
          extract: "$.x",
        },
        {
          id: "dup",
          type: "http",
          target: "B",
          method: "GET",
          url: "https://b.com",
          extract: "$.y",
        },
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("Duplicate action IDs"),
    );
    expect(result.errors).toContainEqual(expect.stringContaining("dup"));
  });

  // -------------------------------------------------------------------------
  // Invalid action type
  // -------------------------------------------------------------------------

  it("detects invalid action types", () => {
    const config = validConfig({
      actions: [
        {
          id: "bad_type",
          type: "graphql" as never,
          target: "Col",
        } as never,
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('invalid type "graphql"'),
    );
  });

  // -------------------------------------------------------------------------
  // Missing required fields — common
  // -------------------------------------------------------------------------

  it("detects missing target field", () => {
    const config = validConfig({
      actions: [
        {
          id: "no_target",
          type: "http",
          target: "",
          method: "GET",
          url: "https://a.com",
          extract: "$.x",
        },
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("missing 'target'"),
    );
  });

  // -------------------------------------------------------------------------
  // Missing required fields — http
  // -------------------------------------------------------------------------

  it("detects missing http action fields (method, url, extract)", () => {
    const config = validConfig({
      actions: [
        {
          id: "bad_http",
          type: "http",
          target: "Col",
          method: "",
          url: "",
          extract: "",
        },
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("http action missing 'method'"),
    );
    expect(result.errors).toContainEqual(
      expect.stringContaining("http action missing 'url'"),
    );
    expect(result.errors).toContainEqual(
      expect.stringContaining("http action missing 'extract'"),
    );
  });

  // -------------------------------------------------------------------------
  // Missing required fields — waterfall
  // -------------------------------------------------------------------------

  it("detects empty providers array in waterfall action", () => {
    const config = validConfig({
      actions: [
        {
          id: "bad_wf",
          type: "waterfall",
          target: "Col",
          providers: [],
        },
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("non-empty 'providers' array"),
    );
  });

  it("detects missing fields in waterfall providers", () => {
    const config = validConfig({
      actions: [
        {
          id: "wf",
          type: "waterfall",
          target: "Col",
          providers: [{ name: "", method: "", url: "", extract: "" }],
        },
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("missing 'name'"),
    );
    expect(result.errors).toContainEqual(
      expect.stringContaining("missing 'method'"),
    );
    expect(result.errors).toContainEqual(
      expect.stringContaining("missing 'url'"),
    );
    expect(result.errors).toContainEqual(
      expect.stringContaining("missing 'extract'"),
    );
  });

  // -------------------------------------------------------------------------
  // Missing required fields — formula
  // -------------------------------------------------------------------------

  it("detects missing expression in formula action", () => {
    const config = validConfig({
      actions: [
        {
          id: "bad_tf",
          type: "formula",
          target: "Col",
          expression: "",
        },
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("formula action missing 'expression'"),
    );
  });

  // -------------------------------------------------------------------------
  // Template validation
  // -------------------------------------------------------------------------

  it("accepts valid templates ({{row.x}} and {{env.X}})", () => {
    const config = validConfig({
      actions: [
        {
          id: "tmpl",
          type: "http",
          target: "Col",
          method: "POST",
          url: "https://api.com/{{row.domain}}",
          headers: { Authorization: "Bearer {{env.API_KEY}}" },
          body: { query: "{{row.name}}" },
          extract: "$.result",
        },
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("detects invalid template syntax in url", () => {
    const config = validConfig({
      actions: [
        {
          id: "bad_tmpl",
          type: "http",
          target: "Col",
          method: "GET",
          url: "https://api.com/{{invalid}}",
          extract: "$.x",
        },
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("invalid template"),
    );
    expect(result.errors).toContainEqual(
      expect.stringContaining("{{invalid}}"),
    );
  });

  it("detects invalid template syntax in headers", () => {
    const config = validConfig({
      actions: [
        {
          id: "bad_hdr",
          type: "http",
          target: "Col",
          method: "GET",
          url: "https://api.com/test",
          headers: { Auth: "{{badvar}}" },
          extract: "$.x",
        },
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("invalid template"),
    );
  });

  it("detects invalid template syntax in body", () => {
    const config = validConfig({
      actions: [
        {
          id: "bad_body",
          type: "http",
          target: "Col",
          method: "POST",
          url: "https://api.com/test",
          body: { nested: { value: "{{foo.bar.baz}}" } },
          extract: "$.x",
        },
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("invalid template"),
    );
  });

  it("detects invalid templates in waterfall provider urls", () => {
    const config = validConfig({
      actions: [
        {
          id: "wf_tmpl",
          type: "waterfall",
          target: "Col",
          providers: [
            {
              name: "prov1",
              method: "GET",
              url: "https://api.com/{{nope}}",
              extract: "$.x",
            },
          ],
        },
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("invalid template"),
    );
  });

  // -------------------------------------------------------------------------
  // Condition parsing
  // -------------------------------------------------------------------------

  it("accepts valid when expressions", () => {
    const config = validConfig({
      actions: [
        {
          id: "cond",
          type: "http",
          target: "Col",
          method: "GET",
          url: "https://api.com/test",
          extract: "$.x",
          when: "row.email && !row.enriched",
        },
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
  });

  it("detects unparseable when expressions", () => {
    const config = validConfig({
      actions: [
        {
          id: "bad_cond",
          type: "http",
          target: "Col",
          method: "GET",
          url: "https://api.com/test",
          extract: "$.x",
          when: "row.email &&& invalid +++",
        },
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("'when' expression has invalid syntax"),
    );
  });

  // -------------------------------------------------------------------------
  // JSONPath validation
  // -------------------------------------------------------------------------

  it("accepts valid JSONPath expressions", () => {
    const config = validConfig({
      actions: [
        {
          id: "jp",
          type: "http",
          target: "Col",
          method: "GET",
          url: "https://api.com/test",
          extract: "$.data[0].email",
        },
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Config size warning
  // -------------------------------------------------------------------------

  it("warns when config size exceeds 25K", () => {
    // Create a config with a very large body to exceed 25K
    const largeActions = [];
    for (let i = 0; i < 100; i++) {
      largeActions.push({
        id: `action_${i}`,
        type: "http" as const,
        target: `Col_${i}`,
        method: "POST",
        url: "https://api.example.com/endpoint",
        body: { data: "x".repeat(250) },
        extract: "$.result",
      });
    }
    const config = validConfig({ actions: largeActions });
    const result = validateConfig(config);
    // The config should be valid but have a size warning
    expect(result.warnings).toContainEqual(
      expect.stringContaining("approaching the 30K Developer Metadata limit"),
    );
  });

  it("does not warn when config is small", () => {
    const result = validateConfig(validConfig());
    expect(result.warnings).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Settings validation
  // -------------------------------------------------------------------------

  it("fails when concurrency is 0", () => {
    const config = validConfig({
      settings: {
        concurrency: 0,
        rateLimit: 10,
        retryAttempts: 3,
        retryBackoff: "exponential",
      },
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("concurrency must be > 0"),
    );
  });

  it("fails when concurrency is negative", () => {
    const config = validConfig({
      settings: {
        concurrency: -1,
        rateLimit: 10,
        retryAttempts: 3,
        retryBackoff: "exponential",
      },
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("concurrency must be > 0"),
    );
  });

  it("passes when rateLimit is 0 (disabled)", () => {
    const config = validConfig({
      settings: {
        concurrency: 5,
        rateLimit: 0,
        retryAttempts: 3,
        retryBackoff: "exponential",
      },
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
  });

  it("fails when rateLimit is negative", () => {
    const config = validConfig({
      settings: {
        concurrency: 5,
        rateLimit: -1,
        retryAttempts: 3,
        retryBackoff: "exponential",
      },
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("rateLimit must be >= 0"),
    );
  });

  it("fails when retryAttempts is negative", () => {
    const config = validConfig({
      settings: {
        concurrency: 5,
        rateLimit: 10,
        retryAttempts: -1,
        retryBackoff: "exponential",
      },
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("retryAttempts must be >= 0"),
    );
  });

  it("passes when retryAttempts is 0", () => {
    const config = validConfig({
      settings: {
        concurrency: 5,
        rateLimit: 10,
        retryAttempts: 0,
        retryBackoff: "exponential",
      },
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
  });

  it("warns when retryBackoff is unknown", () => {
    const config = validConfig({
      settings: {
        concurrency: 5,
        rateLimit: 10,
        retryAttempts: 3,
        retryBackoff: "random_jitter",
      },
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(true); // warning, not error
    expect(result.warnings).toContainEqual(
      expect.stringContaining(
        'retryBackoff "random_jitter" is not a known strategy',
      ),
    );
  });

  it("accepts known retryBackoff values", () => {
    for (const backoff of ["exponential", "linear", "fixed"]) {
      const config = validConfig({
        settings: {
          concurrency: 5,
          rateLimit: 10,
          retryAttempts: 3,
          retryBackoff: backoff,
        },
      });
      const result = validateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    }
  });

  // -------------------------------------------------------------------------
  // Exec action validation
  // -------------------------------------------------------------------------

  it("passes for a valid exec action", () => {
    const config = validConfig({
      actions: [
        {
          id: "run_cmd",
          type: "exec",
          target: "result",
          command: "echo {{row.domain}}",
        } as never,
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("passes for exec action with optional fields", () => {
    const config = validConfig({
      actions: [
        {
          id: "run_cmd",
          type: "exec",
          target: "result",
          command: "echo {{row.domain}}",
          extract: "$.name",
          timeout: 5000,
        } as never,
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("detects missing command in exec action", () => {
    const config = validConfig({
      actions: [
        {
          id: "bad_exec",
          type: "exec",
          target: "result",
          command: "",
        } as never,
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("exec action missing 'command'"),
    );
  });

  it("detects invalid templates in exec action command", () => {
    const config = validConfig({
      actions: [
        {
          id: "tmpl_exec",
          type: "exec",
          target: "result",
          command: "echo {{broken}}",
        } as never,
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("invalid template"),
    );
    expect(result.errors).toContainEqual(expect.stringContaining("{{broken}}"));
  });

  it("detects invalid timeout in exec action", () => {
    const config = validConfig({
      actions: [
        {
          id: "bad_timeout",
          type: "exec",
          target: "result",
          command: "echo hello",
          timeout: -100,
        } as never,
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("'timeout' must be a positive number"),
    );
  });

  it("accepts valid JSONPath in exec action extract", () => {
    const config = validConfig({
      actions: [
        {
          id: "jp_exec",
          type: "exec",
          target: "result",
          command: "echo '{}'",
          extract: "$.data[0].name",
        } as never,
      ],
    });
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Multiple errors at once
  // -------------------------------------------------------------------------

  it("reports multiple errors together", () => {
    const config: PipelineConfig = {
      version: "99",
      actions: [
        {
          id: "dup",
          type: "http",
          target: "A",
          method: "GET",
          url: "https://a.com/{{broken}}",
          extract: "$.x",
        },
        {
          id: "dup",
          type: "unknown" as never,
          target: "B",
        } as never,
      ],
      settings: {
        concurrency: -1,
        rateLimit: -1,
        retryAttempts: -5,
        retryBackoff: "exponential",
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    // Should report version, duplicate IDs, invalid type, invalid template, and settings errors
    expect(result.errors.length).toBeGreaterThanOrEqual(5);
  });
});
