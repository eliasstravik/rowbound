import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPipeline } from "../core/engine.js";
import type {
  Action,
  Adapter,
  CellUpdate,
  PipelineConfig,
  Row,
  SheetRef,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// In-memory adapter (no gws dependency)
// ---------------------------------------------------------------------------

class InMemoryAdapter implements Adapter {
  public rows: Row[];
  public writtenBatches: Array<{ ref: SheetRef; updates: CellUpdate[] }> = [];
  private config: PipelineConfig | null = null;

  constructor(rows: Row[]) {
    this.rows = rows;
  }

  async readRows(_ref: SheetRef): Promise<Row[]> {
    return this.rows;
  }

  async writeCell(_ref: SheetRef, update: CellUpdate): Promise<void> {
    this.writtenBatches.push({ ref: _ref, updates: [update] });
  }

  async writeBatch(ref: SheetRef, updates: CellUpdate[]): Promise<void> {
    this.writtenBatches.push({ ref, updates });
    // Apply updates to in-memory rows for subsequent reads
    for (const update of updates) {
      const rowIndex = update.row - 2; // sheet row 2 = data index 0
      if (this.rows[rowIndex]) {
        this.rows[rowIndex]![update.column] = update.value;
      }
    }
  }

  async readConfig(_ref: SheetRef): Promise<PipelineConfig | null> {
    return this.config;
  }

  async writeConfig(_ref: SheetRef, config: PipelineConfig): Promise<void> {
    this.config = config;
  }

  async getHeaders(_ref: SheetRef): Promise<string[]> {
    if (this.rows.length > 0) {
      return Object.keys(this.rows[0]!);
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REF: SheetRef = {
  spreadsheetId: "integration-test-sheet",
  sheetName: "Sheet1",
};

function makeConfig(
  actions: Action[],
  settings?: Partial<PipelineConfig["settings"]>,
): PipelineConfig {
  return {
    version: "1",
    actions,
    settings: {
      concurrency: 1,
      rateLimit: 0,
      retryAttempts: 0,
      retryBackoff: "exponential",
      ...settings,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: full pipeline without mocking core modules", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. HTTP action with mock fetch
  // -----------------------------------------------------------------------
  describe("HTTP action", () => {
    it("calls API, extracts value, and writes cell update", async () => {
      const adapter = new InMemoryAdapter([
        { domain: "acme.com", company_name: "" },
        { domain: "beta.io", company_name: "" },
      ]);

      const config = makeConfig([
        {
          id: "enrich_company",
          type: "http",
          target: "company_name",
          method: "GET",
          url: "https://api.example.com/company?domain={{row.domain}}",
          extract: "$.name",
        },
      ]);

      // Mock global fetch
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("acme.com")) {
          return new Response(JSON.stringify({ name: "Acme Corp" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ name: "Beta Inc" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await runPipeline({
        adapter,
        ref: REF,
        config,
        env: {},
      });

      expect(result.totalRows).toBe(2);
      expect(result.processedRows).toBe(2);
      expect(result.updates).toBe(2);
      expect(result.errors).toHaveLength(0);

      // Verify fetch was called with resolved template URLs
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]![0]).toBe(
        "https://api.example.com/company?domain=acme.com",
      );
      expect(fetchMock.mock.calls[1]![0]).toBe(
        "https://api.example.com/company?domain=beta.io",
      );

      // Verify cell updates
      expect(adapter.writtenBatches).toHaveLength(2);
      expect(adapter.writtenBatches[0]!.updates).toEqual([
        { row: 2, column: "company_name", value: "Acme Corp" },
      ]);
      expect(adapter.writtenBatches[1]!.updates).toEqual([
        { row: 3, column: "company_name", value: "Beta Inc" },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Waterfall action with provider fallback
  // -----------------------------------------------------------------------
  describe("Waterfall action with provider fallback", () => {
    it("falls back to second provider when first returns empty", async () => {
      const adapter = new InMemoryAdapter([{ domain: "acme.com", email: "" }]);

      const config = makeConfig([
        {
          id: "find_email",
          type: "waterfall",
          target: "email",
          providers: [
            {
              name: "provider_a",
              method: "GET",
              url: "https://provider-a.example.com/lookup?domain={{row.domain}}",
              extract: "$.email",
            },
            {
              name: "provider_b",
              method: "GET",
              url: "https://provider-b.example.com/lookup?domain={{row.domain}}",
              extract: "$.result.email",
            },
          ],
        },
      ]);

      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("provider-a")) {
          // Provider A returns no email (empty result)
          return new Response(JSON.stringify({ email: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        // Provider B returns an email
        return new Response(
          JSON.stringify({ result: { email: "alice@acme.com" } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await runPipeline({
        adapter,
        ref: REF,
        config,
        env: {},
      });

      expect(result.updates).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Both providers were called
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Second provider's result was written
      expect(adapter.writtenBatches[0]!.updates).toEqual([
        { row: 2, column: "email", value: "alice@acme.com" },
      ]);
    });

    it("uses first provider when it succeeds", async () => {
      const adapter = new InMemoryAdapter([{ domain: "acme.com", email: "" }]);

      const config = makeConfig([
        {
          id: "find_email",
          type: "waterfall",
          target: "email",
          providers: [
            {
              name: "provider_a",
              method: "GET",
              url: "https://provider-a.example.com/lookup?domain={{row.domain}}",
              extract: "$.email",
            },
            {
              name: "provider_b",
              method: "GET",
              url: "https://provider-b.example.com/lookup?domain={{row.domain}}",
              extract: "$.email",
            },
          ],
        },
      ]);

      const fetchMock = vi.fn().mockImplementation(async () => {
        return new Response(JSON.stringify({ email: "first@acme.com" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await runPipeline({
        adapter,
        ref: REF,
        config,
        env: {},
      });

      expect(result.updates).toBe(1);
      // Only first provider should be called
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(adapter.writtenBatches[0]!.updates).toEqual([
        { row: 2, column: "email", value: "first@acme.com" },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // 3. Transform action with expression evaluation
  // -----------------------------------------------------------------------
  describe("Transform action with expression evaluation", () => {
    it("evaluates JS expressions and writes results", async () => {
      const adapter = new InMemoryAdapter([
        {
          first_name: "Alice",
          last_name: "Smith",
          full_name: "",
          domain: "",
          email: "alice@acme.com",
        },
        {
          first_name: "Bob",
          last_name: "Jones",
          full_name: "",
          domain: "",
          email: "bob@beta.io",
        },
      ]);

      const config = makeConfig([
        {
          id: "concat_name",
          type: "formula",
          target: "full_name",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: this is a JS expression string for the engine VM, not a TS template
          expression: "`${row.first_name} ${row.last_name}`",
        },
        {
          id: "extract_domain",
          type: "formula",
          target: "domain",
          expression: "row.email.split('@')[1]",
        },
      ]);

      const result = await runPipeline({
        adapter,
        ref: REF,
        config,
        env: {},
      });

      expect(result.totalRows).toBe(2);
      expect(result.processedRows).toBe(2);
      expect(result.updates).toBe(4);
      expect(result.errors).toHaveLength(0);

      // Row 1 updates
      expect(adapter.writtenBatches[0]!.updates).toEqual([
        { row: 2, column: "full_name", value: "Alice Smith" },
        { row: 2, column: "domain", value: "acme.com" },
      ]);

      // Row 2 updates
      expect(adapter.writtenBatches[1]!.updates).toEqual([
        { row: 3, column: "full_name", value: "Bob Jones" },
        { row: 3, column: "domain", value: "beta.io" },
      ]);
    });

    it("chains formulas using in-memory row state", async () => {
      const adapter = new InMemoryAdapter([
        { first: "Alice", last: "Smith", full_name: "", greeting: "" },
      ]);

      const config = makeConfig([
        {
          id: "concat",
          type: "formula",
          target: "full_name",
          expression: "row.first + ' ' + row.last",
        },
        {
          id: "greet",
          type: "formula",
          target: "greeting",
          expression: "'Hello, ' + row.full_name + '!'",
        },
      ]);

      const result = await runPipeline({
        adapter,
        ref: REF,
        config,
        env: {},
      });

      expect(result.updates).toBe(2);
      expect(adapter.writtenBatches[0]!.updates).toEqual([
        { row: 2, column: "full_name", value: "Alice Smith" },
        { row: 2, column: "greeting", value: "Hello, Alice Smith!" },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Condition evaluation (when clause filtering)
  // -----------------------------------------------------------------------
  describe("Condition evaluation (when clause)", () => {
    it("skips rows where when condition is false", async () => {
      const adapter = new InMemoryAdapter([
        { email: "alice@acme.com", domain: "" },
        { email: "", domain: "" },
        { email: "charlie@gamma.com", domain: "" },
      ]);

      const config = makeConfig([
        {
          id: "extract_domain",
          type: "formula",
          target: "domain",
          when: "row.email !== ''",
          expression: "row.email.split('@')[1]",
        },
      ]);

      const result = await runPipeline({
        adapter,
        ref: REF,
        config,
        env: {},
      });

      // Row 2 has no email, so condition is false -> skipped
      expect(result.updates).toBe(2);
      expect(result.processedRows).toBe(3);
      expect(result.errors).toHaveLength(0);

      // Only rows 1 and 3 have updates
      expect(adapter.writtenBatches).toHaveLength(2);
      expect(adapter.writtenBatches[0]!.updates).toEqual([
        { row: 2, column: "domain", value: "acme.com" },
      ]);
      expect(adapter.writtenBatches[1]!.updates).toEqual([
        { row: 4, column: "domain", value: "gamma.com" },
      ]);
    });

    it("skips action when target cell already has a value", async () => {
      const adapter = new InMemoryAdapter([
        { name: "Alice", greeting: "Already set" },
        { name: "Bob", greeting: "" },
      ]);

      const config = makeConfig([
        {
          id: "greet",
          type: "formula",
          target: "greeting",
          expression: "'Hello, ' + row.name",
        },
      ]);

      const result = await runPipeline({
        adapter,
        ref: REF,
        config,
        env: {},
      });

      // First row skipped (target already filled), second row processed
      expect(result.updates).toBe(1);
      expect(adapter.writtenBatches).toHaveLength(1);
      expect(adapter.writtenBatches[0]!.updates).toEqual([
        { row: 3, column: "greeting", value: "Hello, Bob" },
      ]);
    });

    it("uses env variables in when conditions", async () => {
      const adapter = new InMemoryAdapter([
        { source: "linkedin", name: "Alice", tag: "" },
        { source: "manual", name: "Bob", tag: "" },
      ]);

      const config = makeConfig([
        {
          id: "tag_source",
          type: "formula",
          target: "tag",
          when: "row.source === env.TARGET_SOURCE",
          expression: "'tagged'",
        },
      ]);

      const result = await runPipeline({
        adapter,
        ref: REF,
        config,
        env: { TARGET_SOURCE: "linkedin" },
      });

      expect(result.updates).toBe(1);
      expect(adapter.writtenBatches[0]!.updates).toEqual([
        { row: 2, column: "tag", value: "tagged" },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // 5. Dry-run mode (no writes)
  // -----------------------------------------------------------------------
  describe("Dry-run mode", () => {
    it("computes results but does not write to adapter", async () => {
      const adapter = new InMemoryAdapter([
        { first: "Alice", last: "Smith", full_name: "" },
        { first: "Bob", last: "Jones", full_name: "" },
      ]);

      const config = makeConfig([
        {
          id: "concat",
          type: "formula",
          target: "full_name",
          expression: "row.first + ' ' + row.last",
        },
      ]);

      const result = await runPipeline({
        adapter,
        ref: REF,
        config,
        env: {},
        dryRun: true,
      });

      // Updates were computed
      expect(result.updates).toBe(2);
      expect(result.processedRows).toBe(2);
      expect(result.errors).toHaveLength(0);

      // But no writes occurred
      expect(adapter.writtenBatches).toHaveLength(0);
    });

    it("dry-run with HTTP action computes but does not write", async () => {
      const adapter = new InMemoryAdapter([
        { domain: "acme.com", company: "" },
      ]);

      const config = makeConfig([
        {
          id: "enrich",
          type: "http",
          target: "company",
          method: "GET",
          url: "https://api.example.com/company?d={{row.domain}}",
          extract: "$.name",
        },
      ]);

      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ name: "Acme Corp" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await runPipeline({
        adapter,
        ref: REF,
        config,
        env: {},
        dryRun: true,
      });

      expect(result.updates).toBe(1);
      // Fetch was still called (to compute the result)
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // But no writes
      expect(adapter.writtenBatches).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 6. Error handling (onError: skip, write_fallback)
  // -----------------------------------------------------------------------
  describe("Error handling", () => {
    it("onError: skip — skips the action on HTTP error", async () => {
      const adapter = new InMemoryAdapter([
        { domain: "acme.com", company: "" },
      ]);

      const config = makeConfig([
        {
          id: "enrich",
          type: "http",
          target: "company",
          method: "GET",
          url: "https://api.example.com/company?d={{row.domain}}",
          extract: "$.name",
          onError: { "404": "skip", default: "skip" },
        },
      ]);

      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response("Not found", { status: 404 }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await runPipeline({
        adapter,
        ref: REF,
        config,
        env: {},
      });

      // No updates (skipped), no errors (handled gracefully)
      expect(result.updates).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(adapter.writtenBatches).toHaveLength(0);
    });

    it("onError: { write: value } — writes fallback on HTTP error", async () => {
      const adapter = new InMemoryAdapter([
        { domain: "acme.com", company: "" },
      ]);

      // The write_fallback data goes through extractValue, so use "$" to
      // capture the raw fallback string as the result.
      const config = makeConfig([
        {
          id: "enrich",
          type: "http",
          target: "company",
          method: "GET",
          url: "https://api.example.com/company?d={{row.domain}}",
          extract: "$",
          onError: { default: { write: "N/A" } },
        },
      ]);

      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response("Server Error", { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await runPipeline({
        adapter,
        ref: REF,
        config,
        env: {},
      });

      // Fallback value "N/A" was written
      expect(result.updates).toBe(1);
      expect(adapter.writtenBatches[0]!.updates).toEqual([
        { row: 2, column: "company", value: "N/A" },
      ]);
    });

    it("formula expression error is recorded and does not halt pipeline", async () => {
      const adapter = new InMemoryAdapter([
        { value: "ok", result: "" },
        { value: "bad", result: "" },
        { value: "ok_too", result: "" },
      ]);

      const config = makeConfig([
        {
          id: "compute",
          type: "formula",
          target: "result",
          expression:
            "row.value === 'bad' ? undefined_var.crash : row.value.toUpperCase()",
        },
      ]);

      const result = await runPipeline({
        adapter,
        ref: REF,
        config,
        env: {},
      });

      // All 3 rows were processed (pipeline did not halt)
      expect(result.processedRows).toBe(3);
      // 2 successful, 1 error
      expect(result.updates).toBe(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.rowIndex).toBe(1);
      expect(result.errors[0]!.actionId).toBe("compute");

      // Rows 0 and 2 were written
      expect(adapter.writtenBatches).toHaveLength(2);
      expect(adapter.writtenBatches[0]!.updates).toEqual([
        { row: 2, column: "result", value: "OK" },
      ]);
      expect(adapter.writtenBatches[1]!.updates).toEqual([
        { row: 4, column: "result", value: "OK_TOO" },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // 7. Multi-action pipeline: HTTP + Transform + Waterfall
  // -----------------------------------------------------------------------
  describe("Multi-action pipeline", () => {
    it("chains HTTP, formula, and waterfall actions across rows", async () => {
      const adapter = new InMemoryAdapter([
        {
          domain: "acme.com",
          company_name: "",
          upper_company: "",
          email: "",
        },
      ]);

      const config = makeConfig([
        {
          id: "get_company",
          type: "http",
          target: "company_name",
          method: "GET",
          url: "https://api.example.com/company?d={{row.domain}}",
          extract: "$.name",
        },
        {
          id: "upper",
          type: "formula",
          target: "upper_company",
          expression: "row.company_name.toUpperCase()",
        },
        {
          id: "find_email",
          type: "waterfall",
          target: "email",
          providers: [
            {
              name: "hunter",
              method: "GET",
              url: "https://hunter.example.com/find?domain={{row.domain}}",
              extract: "$.data.email",
            },
          ],
        },
      ]);

      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("api.example.com")) {
          return new Response(JSON.stringify({ name: "Acme Corp" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("hunter.example.com")) {
          return new Response(
            JSON.stringify({ data: { email: "contact@acme.com" } }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("Not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await runPipeline({
        adapter,
        ref: REF,
        config,
        env: {},
      });

      expect(result.updates).toBe(3);
      expect(result.errors).toHaveLength(0);

      const updates = adapter.writtenBatches[0]!.updates;
      // Dependency sort may reorder actions (email has no deps, upper_company
      // depends on company_name) — check values regardless of order
      expect(updates).toHaveLength(3);
      expect(updates).toEqual(
        expect.arrayContaining([
          { row: 2, column: "company_name", value: "Acme Corp" },
          { row: 2, column: "upper_company", value: "ACME CORP" },
          { row: 2, column: "email", value: "contact@acme.com" },
        ]),
      );
    });
  });

  // -----------------------------------------------------------------------
  // 8. Column map (ID-keyed rows)
  // -----------------------------------------------------------------------
  describe("Column map (ID-keyed rows)", () => {
    it("maps column IDs to header names for reads and writes", async () => {
      const adapter = new InMemoryAdapter([
        { Domain: "acme.com", "Full Name": "" },
      ]);

      const columnMap: Record<string, string> = {
        col_domain: "Domain",
        col_fullname: "Full Name",
      };

      const config = makeConfig([
        {
          id: "copy_domain",
          type: "formula",
          target: "col_fullname",
          expression: "'Name for ' + row.col_domain",
        },
      ]);

      const result = await runPipeline({
        adapter,
        ref: REF,
        config,
        env: {},
        columnMap,
      });

      expect(result.updates).toBe(1);
      // Write uses the header name (resolved from column map)
      expect(adapter.writtenBatches[0]!.updates).toEqual([
        { row: 2, column: "Full Name", value: "Name for acme.com" },
      ]);
    });
  });
});
