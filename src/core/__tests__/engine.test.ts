import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateExpression, runPipeline } from "../engine.js";
import type {
  Adapter,
  CellUpdate,
  ExecutionContext,
  PipelineConfig,
  Row,
  SheetRef,
} from "../types.js";

// Mock HTTP dependencies so no real network calls are made
vi.mock("../http-client.js", () => ({
  httpRequest: vi.fn(),
  StopProviderError: class StopProviderError extends Error {
    constructor(message = "Provider stopped") {
      super(message);
      this.name = "StopProviderError";
    }
  },
}));

vi.mock("../extractor.js", () => ({
  extractValue: vi.fn(),
}));

vi.mock("../waterfall.js", () => ({
  executeWaterfall: vi.fn(),
}));

vi.mock("../exec.js", () => ({
  executeExecAction: vi.fn(),
}));

import { executeExecAction } from "../exec.js";
import { extractValue } from "../extractor.js";
import { httpRequest } from "../http-client.js";
import { executeWaterfall } from "../waterfall.js";

const mockHttpRequest = vi.mocked(httpRequest);
const mockExtractValue = vi.mocked(extractValue);
const mockExecuteWaterfall = vi.mocked(executeWaterfall);
const mockExecuteExecAction = vi.mocked(executeExecAction);

/** Minimal mock adapter for testing */
class MockAdapter implements Adapter {
  private rows: Row[] = [];
  public writtenBatches: Array<{ ref: SheetRef; updates: CellUpdate[] }> = [];

  constructor(rows: Row[] = []) {
    this.rows = rows;
  }

  async readRows(_ref: SheetRef): Promise<Row[]> {
    return this.rows;
  }

  async writeCell(_ref: SheetRef, _update: CellUpdate): Promise<void> {}

  async writeBatch(ref: SheetRef, updates: CellUpdate[]): Promise<void> {
    this.writtenBatches.push({ ref, updates });
  }

  async readConfig(_ref: SheetRef): Promise<PipelineConfig | null> {
    return null;
  }

  async writeConfig(_ref: SheetRef, _config: PipelineConfig): Promise<void> {}

  async getHeaders(_ref: SheetRef): Promise<string[]> {
    if (this.rows.length > 0) {
      return Object.keys(this.rows[0]!);
    }
    return [];
  }
}

const REF: SheetRef = { spreadsheetId: "test-sheet-id", sheetName: "Sheet1" };

function makeConfig(
  actions: PipelineConfig["actions"],
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

describe("evaluateExpression", () => {
  it("returns string from expression", () => {
    const context: ExecutionContext = {
      row: { first: "Alice", last: "Smith" },
      env: {},
    };
    const result = evaluateExpression("row.first + ' ' + row.last", context);
    expect(result).toBe("Alice Smith");
  });

  it("returns empty string for null/undefined result", () => {
    const context: ExecutionContext = { row: {}, env: {} };
    const result = evaluateExpression("row.missing", context);
    expect(result).toBe("");
  });

  it("stringifies object results", () => {
    const context: ExecutionContext = {
      row: { data: '{"a":1}' },
      env: {},
    };
    const result = evaluateExpression("({a: 1})", context);
    expect(result).toBe('{"a":1}');
  });

  it("converts numbers to strings", () => {
    const context: ExecutionContext = { row: {}, env: {} };
    const result = evaluateExpression("42", context);
    expect(result).toBe("42");
  });

  it("has access to env variables", () => {
    const context: ExecutionContext = {
      row: {},
      env: { PREFIX: "hello" },
    };
    const result = evaluateExpression("env.PREFIX + '_world'", context);
    expect(result).toBe("hello_world");
  });

  it("throws on syntax errors", () => {
    const context: ExecutionContext = { row: {}, env: {} };
    expect(() => evaluateExpression("if(", context)).toThrow();
  });

  it("expands {{column}} refs to row access", () => {
    const context: ExecutionContext = {
      row: { Email: "test@example.com" },
      env: {},
    };
    expect(evaluateExpression('{{Email}}.split("@")[1]', context)).toBe(
      "example.com",
    );
  });
});

describe("runPipeline", () => {
  beforeEach(() => {
    mockHttpRequest.mockReset();
    mockExtractValue.mockReset();
    mockExecuteWaterfall.mockReset();
    mockExecuteExecAction.mockReset();
  });

  it("processes transform actions", async () => {
    const adapter = new MockAdapter([
      { first_name: "Alice", last_name: "Smith", full_name: "" },
      { first_name: "Bob", last_name: "Jones", full_name: "" },
    ]);

    const config = makeConfig([
      {
        id: "concat_name",
        type: "transform",
        target: "full_name",
        expression: "row.first_name + ' ' + row.last_name",
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
    expect(result.updates).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Check written batches
    expect(adapter.writtenBatches).toHaveLength(2);
    expect(adapter.writtenBatches[0]!.updates).toEqual([
      { row: 2, column: "full_name", value: "Alice Smith" },
    ]);
    expect(adapter.writtenBatches[1]!.updates).toEqual([
      { row: 3, column: "full_name", value: "Bob Jones" },
    ]);
  });

  it("processes HTTP actions", async () => {
    const adapter = new MockAdapter([{ domain: "acme.com", company_name: "" }]);

    const config = makeConfig([
      {
        id: "enrich_company",
        type: "http",
        target: "company_name",
        method: "GET",
        url: "https://api.example.com/{{row.domain}}",
        extract: "$.name",
      },
    ]);

    mockHttpRequest.mockResolvedValueOnce({
      status: 200,
      data: { name: "Acme Corp" },
    });
    mockExtractValue.mockReturnValueOnce("Acme Corp");

    const result = await runPipeline({
      adapter,
      ref: REF,
      config,
      env: {},
    });

    expect(result.updates).toBe(1);
    expect(adapter.writtenBatches[0]!.updates).toEqual([
      { row: 2, column: "company_name", value: "Acme Corp" },
    ]);
  });

  it("processes waterfall actions", async () => {
    const adapter = new MockAdapter([{ domain: "acme.com", email: "" }]);

    const config = makeConfig([
      {
        id: "find_email",
        type: "waterfall",
        target: "email",
        providers: [
          {
            name: "provider-a",
            method: "GET",
            url: "https://a.example.com",
            extract: "$.email",
          },
        ],
      },
    ]);

    mockExecuteWaterfall.mockResolvedValueOnce({
      value: "alice@acme.com",
      provider: "provider-a",
    });

    const result = await runPipeline({
      adapter,
      ref: REF,
      config,
      env: {},
    });

    expect(result.updates).toBe(1);
    expect(adapter.writtenBatches[0]!.updates).toEqual([
      { row: 2, column: "email", value: "alice@acme.com" },
    ]);
  });

  it("full pipeline with transform + http + waterfall", async () => {
    const adapter = new MockAdapter([
      { first: "Alice", last: "Smith", full_name: "", title: "", email: "" },
    ]);

    const config = makeConfig([
      {
        id: "concat",
        type: "transform",
        target: "full_name",
        expression: "row.first + ' ' + row.last",
      },
      {
        id: "get_title",
        type: "http",
        target: "title",
        method: "GET",
        url: "https://api.example.com/title",
        extract: "$.title",
      },
      {
        id: "find_email",
        type: "waterfall",
        target: "email",
        providers: [
          {
            name: "p1",
            method: "GET",
            url: "https://a.example.com",
            extract: "$.email",
          },
        ],
      },
    ]);

    mockHttpRequest.mockResolvedValueOnce({
      status: 200,
      data: { title: "VP Sales" },
    });
    mockExtractValue.mockReturnValueOnce("VP Sales");

    mockExecuteWaterfall.mockResolvedValueOnce({
      value: "alice@acme.com",
      provider: "p1",
    });

    const result = await runPipeline({
      adapter,
      ref: REF,
      config,
      env: {},
    });

    expect(result.updates).toBe(3);
    expect(result.errors).toHaveLength(0);

    const updates = adapter.writtenBatches[0]!.updates;
    expect(updates).toEqual([
      { row: 2, column: "full_name", value: "Alice Smith" },
      { row: 2, column: "title", value: "VP Sales" },
      { row: 2, column: "email", value: "alice@acme.com" },
    ]);
  });

  it("skips action when condition returns false", async () => {
    const adapter = new MockAdapter([
      { email: "already@set.com", domain: "acme.com" },
      { email: "", domain: "beta.com" },
    ]);

    const config = makeConfig([
      {
        id: "find_email",
        type: "waterfall",
        target: "email",
        when: "!row.email",
        providers: [
          {
            name: "p1",
            method: "GET",
            url: "https://api.example.com",
            extract: "$.email",
          },
        ],
      },
    ]);

    // Only called for second row (first row has email already)
    mockExecuteWaterfall.mockResolvedValueOnce({
      value: "new@beta.com",
      provider: "p1",
    });

    const result = await runPipeline({
      adapter,
      ref: REF,
      config,
      env: {},
    });

    // First row skipped (condition false), second row processed
    expect(mockExecuteWaterfall).toHaveBeenCalledTimes(1);
    expect(result.updates).toBe(1);

    // Only second row has updates
    expect(adapter.writtenBatches).toHaveLength(1);
    expect(adapter.writtenBatches[0]!.updates).toEqual([
      { row: 3, column: "email", value: "new@beta.com" },
    ]);
  });

  it("updates in-memory row state between actions", async () => {
    const adapter = new MockAdapter([
      { first: "Alice", last: "Smith", full_name: "", greeting: "" },
    ]);

    const config = makeConfig([
      {
        id: "concat",
        type: "transform",
        target: "full_name",
        expression: "row.first + ' ' + row.last",
      },
      {
        id: "greet",
        type: "transform",
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
    const updates = adapter.writtenBatches[0]!.updates;
    expect(updates[0]).toEqual({
      row: 2,
      column: "full_name",
      value: "Alice Smith",
    });
    expect(updates[1]).toEqual({
      row: 2,
      column: "greeting",
      value: "Hello, Alice Smith!",
    });
  });

  it("dry run executes but does not write", async () => {
    const adapter = new MockAdapter([
      { first: "Alice", last: "Smith", full_name: "" },
    ]);

    const config = makeConfig([
      {
        id: "concat",
        type: "transform",
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

    expect(result.updates).toBe(1);
    // No writes should have happened
    expect(adapter.writtenBatches).toHaveLength(0);
  });

  it("action filter only runs the specified action", async () => {
    const adapter = new MockAdapter([{ a: "", b: "" }]);

    const config = makeConfig([
      {
        id: "action_a",
        type: "transform",
        target: "a",
        expression: "'value_a'",
      },
      {
        id: "action_b",
        type: "transform",
        target: "b",
        expression: "'value_b'",
      },
    ]);

    const result = await runPipeline({
      adapter,
      ref: REF,
      config,
      env: {},
      actionFilter: "action_b",
    });

    expect(result.updates).toBe(1);
    expect(adapter.writtenBatches[0]!.updates).toEqual([
      { row: 2, column: "b", value: "value_b" },
    ]);
  });

  it("abort signal stops processing between rows", async () => {
    const adapter = new MockAdapter([
      { name: "Alice", result: "" },
      { name: "Bob", result: "" },
      { name: "Charlie", result: "" },
    ]);

    const config = makeConfig([
      {
        id: "greet",
        type: "transform",
        target: "result",
        expression: "'Hi ' + row.name",
      },
    ]);

    const controller = new AbortController();

    // Abort after first row is processed
    const onRowComplete = vi.fn().mockImplementation(() => {
      controller.abort();
    });

    const result = await runPipeline({
      adapter,
      ref: REF,
      config,
      env: {},
      signal: controller.signal,
      onRowComplete,
    });

    // Should process first row then stop
    expect(result.processedRows).toBe(1);
    expect(adapter.writtenBatches).toHaveLength(1);
  });

  it("handles errors and continues processing", async () => {
    const adapter = new MockAdapter([
      { value: "ok", result: "" },
      { value: "bad", result: "" },
    ]);

    const config = makeConfig([
      {
        id: "compute",
        type: "transform",
        target: "result",
        expression: "row.value === 'bad' ? undefined_var.crash : 'good'",
      },
    ]);

    const onError = vi.fn();

    const result = await runPipeline({
      adapter,
      ref: REF,
      config,
      env: {},
      onError,
    });

    expect(result.processedRows).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.rowIndex).toBe(1);
    expect(result.errors[0]!.actionId).toBe("compute");
    expect(onError).toHaveBeenCalledTimes(1);

    // First row should have been written
    expect(adapter.writtenBatches).toHaveLength(1);
    expect(adapter.writtenBatches[0]!.updates).toEqual([
      { row: 2, column: "result", value: "good" },
    ]);
  });

  it("fires progress callbacks", async () => {
    const adapter = new MockAdapter([{ name: "Alice", greeting: "" }]);

    const config = makeConfig([
      {
        id: "greet",
        type: "transform",
        target: "greeting",
        expression: "'Hi ' + row.name",
      },
    ]);

    const onRowStart = vi.fn();
    const onRowComplete = vi.fn();
    const onActionComplete = vi.fn();

    await runPipeline({
      adapter,
      ref: REF,
      config,
      env: {},
      onRowStart,
      onRowComplete,
      onActionComplete,
    });

    expect(onRowStart).toHaveBeenCalledTimes(1);
    expect(onRowStart).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ name: "Alice" }),
    );

    expect(onActionComplete).toHaveBeenCalledTimes(1);
    expect(onActionComplete).toHaveBeenCalledWith(0, "greet", "Hi Alice");

    expect(onRowComplete).toHaveBeenCalledTimes(1);
    expect(onRowComplete).toHaveBeenCalledWith(0, [
      { row: 2, column: "greeting", value: "Hi Alice" },
    ]);
  });

  it("reports correct row numbers (data row 0 = sheet row 2)", async () => {
    const adapter = new MockAdapter([
      { x: "first", y: "" },
      { x: "second", y: "" },
      { x: "third", y: "" },
    ]);

    const config = makeConfig([
      {
        id: "copy",
        type: "transform",
        target: "y",
        expression: "row.x",
      },
    ]);

    await runPipeline({ adapter, ref: REF, config, env: {} });

    expect(adapter.writtenBatches[0]!.updates[0]!.row).toBe(2);
    expect(adapter.writtenBatches[1]!.updates[0]!.row).toBe(3);
    expect(adapter.writtenBatches[2]!.updates[0]!.row).toBe(4);
  });

  it("handles HTTP action returning null", async () => {
    const adapter = new MockAdapter([{ domain: "acme.com", company: "" }]);

    const config = makeConfig([
      {
        id: "enrich",
        type: "http",
        target: "company",
        method: "GET",
        url: "https://api.example.com/{{row.domain}}",
        extract: "$.name",
        onError: { default: "skip" },
      },
    ]);

    mockHttpRequest.mockResolvedValueOnce(null);

    const result = await runPipeline({
      adapter,
      ref: REF,
      config,
      env: {},
    });

    // No value extracted, no update
    expect(result.updates).toBe(0);
    expect(adapter.writtenBatches).toHaveLength(0);
  });

  it("handles waterfall returning null", async () => {
    const adapter = new MockAdapter([{ domain: "acme.com", email: "" }]);

    const config = makeConfig([
      {
        id: "find_email",
        type: "waterfall",
        target: "email",
        providers: [],
      },
    ]);

    mockExecuteWaterfall.mockResolvedValueOnce(null);

    const result = await runPipeline({
      adapter,
      ref: REF,
      config,
      env: {},
    });

    expect(result.updates).toBe(0);
  });

  it("passes env to execution context", async () => {
    const adapter = new MockAdapter([{ name: "Alice", tag: "" }]);

    const config = makeConfig([
      {
        id: "tag",
        type: "transform",
        target: "tag",
        expression: "env.SOURCE",
      },
    ]);

    const result = await runPipeline({
      adapter,
      ref: REF,
      config,
      env: { SOURCE: "linkedin" },
    });

    expect(result.updates).toBe(1);
    expect(adapter.writtenBatches[0]!.updates).toEqual([
      { row: 2, column: "tag", value: "linkedin" },
    ]);
  });

  it("skipped rows count is correct", async () => {
    const adapter = new MockAdapter([{ x: "1" }, { x: "2" }, { x: "3" }]);

    const config = makeConfig([
      {
        id: "noop",
        type: "transform",
        target: "x",
        expression: "row.x",
      },
    ]);

    const result = await runPipeline({
      adapter,
      ref: REF,
      config,
      env: {},
    });

    expect(result.totalRows).toBe(3);
    expect(result.processedRows).toBe(3);
    expect(result.skippedRows).toBe(0);
  });

  it("does not write batch when row has no updates", async () => {
    const adapter = new MockAdapter([{ email: "existing@acme.com" }]);

    const config = makeConfig([
      {
        id: "find_email",
        type: "waterfall",
        target: "email",
        when: "!row.email",
        providers: [
          {
            name: "p1",
            method: "GET",
            url: "https://api.example.com",
            extract: "$.email",
          },
        ],
      },
    ]);

    const result = await runPipeline({
      adapter,
      ref: REF,
      config,
      env: {},
    });

    expect(result.updates).toBe(0);
    expect(adapter.writtenBatches).toHaveLength(0);
  });

  it("processes exec actions", async () => {
    const adapter = new MockAdapter([{ domain: "acme.com", whois_info: "" }]);

    const config = makeConfig([
      {
        id: "whois_lookup",
        type: "exec",
        target: "whois_info",
        command: "whois {{row.domain}}",
      },
    ]);

    mockExecuteExecAction.mockResolvedValueOnce("Registrant: Acme Corp");

    const result = await runPipeline({
      adapter,
      ref: REF,
      config,
      env: {},
    });

    expect(result.updates).toBe(1);
    expect(adapter.writtenBatches[0]!.updates).toEqual([
      { row: 2, column: "whois_info", value: "Registrant: Acme Corp" },
    ]);
    expect(mockExecuteExecAction).toHaveBeenCalledTimes(1);
  });

  it("exec action returning null produces no update", async () => {
    const adapter = new MockAdapter([{ domain: "acme.com", result: "" }]);

    const config = makeConfig([
      {
        id: "exec_action",
        type: "exec",
        target: "result",
        command: "some-command",
        onError: { default: "skip" },
      },
    ]);

    mockExecuteExecAction.mockResolvedValueOnce(null);

    const result = await runPipeline({
      adapter,
      ref: REF,
      config,
      env: {},
    });

    expect(result.updates).toBe(0);
    expect(adapter.writtenBatches).toHaveLength(0);
  });
});
