import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Adapter,
  CellUpdate,
  ExecSource,
  HttpSource,
  PipelineConfig,
  Row,
  SheetRef,
  WebhookSource,
} from "../types.js";

// Mock HTTP and exec dependencies
vi.mock("../http-client.js", () => ({
  httpRequest: vi.fn(),
  StopProviderError: class StopProviderError extends Error {
    constructor(message = "Provider stopped") {
      super(message);
      this.name = "StopProviderError";
    }
  },
}));

vi.mock("../exec.js", () => ({
  executeCommand: vi.fn(),
  executeExecAction: vi.fn(),
}));

import { executeCommand } from "../exec.js";
import { httpRequest } from "../http-client.js";
import { executeSource, executeWebhookSource } from "../source.js";

const mockHttpRequest = vi.mocked(httpRequest);
const mockExecuteCommand = vi.mocked(executeCommand);

class MockAdapter implements Adapter {
  public writtenBatches: Array<{ ref: SheetRef; updates: CellUpdate[] }> = [];
  private tabData: Map<string, Row[]>;
  private tabHeaders: Map<string, string[]>;

  constructor(
    tabData: Map<string, Row[]> = new Map(),
    tabHeaders?: Map<string, string[]>,
  ) {
    this.tabData = tabData;
    this.tabHeaders =
      tabHeaders ??
      new Map(
        [...tabData.entries()].map(([name, rows]) => [
          name,
          rows.length > 0 ? Object.keys(rows[0]!) : [],
        ]),
      );
  }

  async readRows(ref: SheetRef): Promise<Row[]> {
    return this.tabData.get(ref.sheetName ?? "Sheet1") ?? [];
  }

  async writeCell(_ref: SheetRef, _update: CellUpdate): Promise<void> {}
  async writeBatch(ref: SheetRef, updates: CellUpdate[]): Promise<void> {
    this.writtenBatches.push({ ref, updates });
  }
  async readConfig(_ref: SheetRef): Promise<PipelineConfig | null> {
    return null;
  }
  async writeConfig(_ref: SheetRef, _config: PipelineConfig): Promise<void> {}
  async getHeaders(ref: SheetRef): Promise<string[]> {
    const tabName = ref.sheetName ?? "Sheet1";
    const headers = this.tabHeaders.get(tabName);
    if (!headers) throw new Error(`Tab "${tabName}" not found`);
    return headers;
  }
}

const REF: SheetRef = { spreadsheetId: "test-id", sheetName: "Sheet1" };

describe("executeSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("http source", () => {
    it("creates rows from API response array", async () => {
      const adapter = new MockAdapter(
        new Map([["Sheet1", []]]),
        new Map([["Sheet1", ["Name", "Email", "Company"]]]),
      );

      mockHttpRequest.mockResolvedValue({
        status: 200,
        data: [
          { name: "Alice", email: "alice@acme.com", company: "Acme" },
          { name: "Bob", email: "bob@acme.com", company: "Acme" },
        ],
      });

      const source: HttpSource = {
        id: "test_source",
        type: "http",
        method: "GET",
        url: "https://api.example.com/people",
        extract: "$",
        columns: {
          Name: "$.name",
          Email: "$.email",
          Company: "$.company",
        },
      };

      const result = await executeSource(source, {
        adapter,
        ref: REF,
        env: {},
      });

      expect(result.rowsCreated).toBe(2);
      expect(result.errors).toHaveLength(0);
      expect(adapter.writtenBatches).toHaveLength(1);

      const updates = adapter.writtenBatches[0]!.updates;
      expect(updates).toContainEqual({
        row: 2,
        column: "Name",
        value: "Alice",
      });
      expect(updates).toContainEqual({
        row: 2,
        column: "Email",
        value: "alice@acme.com",
      });
      expect(updates).toContainEqual({
        row: 3,
        column: "Name",
        value: "Bob",
      });
    });

    it("extracts array from nested response using extractPath", async () => {
      const adapter = new MockAdapter(
        new Map([["Sheet1", []]]),
        new Map([["Sheet1", ["Name"]]]),
      );

      mockHttpRequest.mockResolvedValue({
        status: 200,
        data: {
          meta: { total: 2 },
          results: [{ name: "Alice" }, { name: "Bob" }],
        },
      });

      const source: HttpSource = {
        id: "nested",
        type: "http",
        method: "GET",
        url: "https://api.example.com",
        extract: "$",
        extractPath: "$.results",
        columns: { Name: "$.name" },
      };

      const result = await executeSource(source, {
        adapter,
        ref: REF,
        env: {},
      });

      expect(result.rowsCreated).toBe(2);
    });

    it("does not write in dry run mode", async () => {
      const adapter = new MockAdapter(
        new Map([["Sheet1", []]]),
        new Map([["Sheet1", ["Name"]]]),
      );

      mockHttpRequest.mockResolvedValue({
        status: 200,
        data: [{ name: "Alice" }],
      });

      const source: HttpSource = {
        id: "dry",
        type: "http",
        method: "GET",
        url: "https://api.example.com",
        extract: "$",
        columns: { Name: "$.name" },
      };

      const result = await executeSource(source, {
        adapter,
        ref: REF,
        env: {},
        dryRun: true,
      });

      expect(result.rowsCreated).toBe(1);
      expect(adapter.writtenBatches).toHaveLength(0);
    });
  });

  describe("exec source", () => {
    it("creates rows from command output", async () => {
      const adapter = new MockAdapter(
        new Map([["Sheet1", []]]),
        new Map([["Sheet1", ["Name", "Score"]]]),
      );

      mockExecuteCommand.mockResolvedValue({
        stdout: JSON.stringify([
          { name: "Alice", score: 95 },
          { name: "Bob", score: 80 },
        ]),
        stderr: "",
        exitCode: 0,
      });

      const source: ExecSource = {
        id: "exec_source",
        type: "exec",
        command: 'echo \'[{"name":"Alice","score":95}]\'',
        columns: { Name: "$.name", Score: "$.score" },
      };

      const result = await executeSource(source, {
        adapter,
        ref: REF,
        env: {},
      });

      expect(result.rowsCreated).toBe(2);
      expect(adapter.writtenBatches).toHaveLength(1);
    });

    it("handles command failure gracefully", async () => {
      const adapter = new MockAdapter(
        new Map([["Sheet1", []]]),
        new Map([["Sheet1", ["Name"]]]),
      );

      mockExecuteCommand.mockResolvedValue({
        stdout: "",
        stderr: "command not found",
        exitCode: 1,
      });

      const source: ExecSource = {
        id: "fail",
        type: "exec",
        command: "nonexistent_command",
        columns: { Name: "$.name" },
      };

      const result = await executeSource(source, {
        adapter,
        ref: REF,
        env: {},
      });

      expect(result.rowsCreated).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("exited with code 1");
    });
  });

  describe("dedup", () => {
    it("skips rows that already exist (dedup without updateExisting)", async () => {
      const existingRows: Row[] = [{ Name: "Alice", Email: "alice@acme.com" }];
      const adapter = new MockAdapter(
        new Map([["Sheet1", existingRows]]),
        new Map([["Sheet1", ["Name", "Email"]]]),
      );

      mockHttpRequest.mockResolvedValue({
        status: 200,
        data: [
          { name: "Alice", email: "alice@acme.com" },
          { name: "Bob", email: "bob@acme.com" },
        ],
      });

      const source: HttpSource = {
        id: "dedup_test",
        type: "http",
        method: "GET",
        url: "https://api.example.com",
        extract: "$",
        columns: { Name: "$.name", Email: "$.email" },
        dedup: "Email",
      };

      const result = await executeSource(source, {
        adapter,
        ref: REF,
        env: {},
      });

      expect(result.rowsCreated).toBe(1); // Only Bob
      expect(result.rowsSkipped).toBe(1); // Alice skipped
    });

    it("updates existing rows when updateExisting is true", async () => {
      const existingRows: Row[] = [
        { Name: "Old Alice", Email: "alice@acme.com" },
      ];
      const adapter = new MockAdapter(
        new Map([["Sheet1", existingRows]]),
        new Map([["Sheet1", ["Name", "Email"]]]),
      );

      mockHttpRequest.mockResolvedValue({
        status: 200,
        data: [{ name: "New Alice", email: "alice@acme.com" }],
      });

      const source: HttpSource = {
        id: "upsert_test",
        type: "http",
        method: "GET",
        url: "https://api.example.com",
        extract: "$",
        columns: { Name: "$.name", Email: "$.email" },
        dedup: "Email",
        updateExisting: true,
      };

      const result = await executeSource(source, {
        adapter,
        ref: REF,
        env: {},
      });

      expect(result.rowsUpdated).toBe(1);
      expect(result.rowsCreated).toBe(0);

      const updates = adapter.writtenBatches[0]!.updates;
      // Row 2 = existing Alice (index 0 + 2)
      expect(updates).toContainEqual({
        row: 2,
        column: "Name",
        value: "New Alice",
      });
    });

    it("deduplicates within the same batch", async () => {
      const adapter = new MockAdapter(
        new Map([["Sheet1", []]]),
        new Map([["Sheet1", ["Name", "Email"]]]),
      );

      mockHttpRequest.mockResolvedValue({
        status: 200,
        data: [
          { name: "Alice", email: "alice@acme.com" },
          { name: "Alice Dup", email: "alice@acme.com" },
        ],
      });

      const source: HttpSource = {
        id: "batch_dedup",
        type: "http",
        method: "GET",
        url: "https://api.example.com",
        extract: "$",
        columns: { Name: "$.name", Email: "$.email" },
        dedup: "Email",
      };

      const result = await executeSource(source, {
        adapter,
        ref: REF,
        env: {},
      });

      expect(result.rowsCreated).toBe(1); // First Alice
      expect(result.rowsSkipped).toBe(1); // Duplicate skipped
    });
  });

  describe("column mapping", () => {
    it("extracts nested fields via JSONPath", async () => {
      const adapter = new MockAdapter(
        new Map([["Sheet1", []]]),
        new Map([["Sheet1", ["Name", "City"]]]),
      );

      mockHttpRequest.mockResolvedValue({
        status: 200,
        data: [{ name: "Alice", location: { city: "Stockholm" } }],
      });

      const source: HttpSource = {
        id: "nested_cols",
        type: "http",
        method: "GET",
        url: "https://api.example.com",
        extract: "$",
        columns: { Name: "$.name", City: "$.location.city" },
      };

      const result = await executeSource(source, {
        adapter,
        ref: REF,
        env: {},
      });

      expect(result.rowsCreated).toBe(1);
      const updates = adapter.writtenBatches[0]!.updates;
      expect(updates).toContainEqual({
        row: 2,
        column: "City",
        value: "Stockholm",
      });
    });

    it("uses literal values for non-JSONPath columns", async () => {
      const adapter = new MockAdapter(
        new Map([["Sheet1", []]]),
        new Map([["Sheet1", ["Name", "Source"]]]),
      );

      mockHttpRequest.mockResolvedValue({
        status: 200,
        data: [{ name: "Alice" }],
      });

      const source: HttpSource = {
        id: "literal",
        type: "http",
        method: "GET",
        url: "https://api.example.com",
        extract: "$",
        columns: { Name: "$.name", Source: "Blitz API" },
      };

      await executeSource(source, {
        adapter,
        ref: REF,
        env: {},
      });

      const updates = adapter.writtenBatches[0]!.updates;
      expect(updates).toContainEqual({
        row: 2,
        column: "Source",
        value: "Blitz API",
      });
    });

    it("skips columns not in sheet headers", async () => {
      const adapter = new MockAdapter(
        new Map([["Sheet1", []]]),
        new Map([["Sheet1", ["Name"]]]), // No "Email" header
      );

      mockHttpRequest.mockResolvedValue({
        status: 200,
        data: [{ name: "Alice", email: "alice@acme.com" }],
      });

      const source: HttpSource = {
        id: "missing_col",
        type: "http",
        method: "GET",
        url: "https://api.example.com",
        extract: "$",
        columns: { Name: "$.name", Email: "$.email" },
      };

      const result = await executeSource(source, {
        adapter,
        ref: REF,
        env: {},
      });

      expect(result.rowsCreated).toBe(1);
      const updates = adapter.writtenBatches[0]!.updates;
      expect(updates).toHaveLength(1);
      expect(updates[0]!.column).toBe("Name");
    });
  });

  describe("empty responses", () => {
    it("returns 0 rows for empty array", async () => {
      const adapter = new MockAdapter(
        new Map([["Sheet1", []]]),
        new Map([["Sheet1", ["Name"]]]),
      );

      mockHttpRequest.mockResolvedValue({
        status: 200,
        data: [],
      });

      const source: HttpSource = {
        id: "empty",
        type: "http",
        method: "GET",
        url: "https://api.example.com",
        extract: "$",
        columns: { Name: "$.name" },
      };

      const result = await executeSource(source, {
        adapter,
        ref: REF,
        env: {},
      });

      expect(result.rowsCreated).toBe(0);
      expect(adapter.writtenBatches).toHaveLength(0);
    });
  });
});

describe("executeWebhookSource", () => {
  it("creates a row from webhook payload", async () => {
    const adapter = new MockAdapter(
      new Map([["Sheet1", []]]),
      new Map([["Sheet1", ["Name", "Email"]]]),
    );

    const source: WebhookSource = {
      id: "webhook_test",
      type: "webhook",
      columns: { Name: "$.name", Email: "$.email" },
    };

    const payload = { name: "Alice", email: "alice@acme.com" };

    const result = await executeWebhookSource(source, payload, {
      adapter,
      ref: REF,
      env: {},
    });

    expect(result.rowsCreated).toBe(1);
    const updates = adapter.writtenBatches[0]!.updates;
    expect(updates).toContainEqual({
      row: 2,
      column: "Name",
      value: "Alice",
    });
  });

  it("creates multiple rows from array payload", async () => {
    const adapter = new MockAdapter(
      new Map([["Sheet1", []]]),
      new Map([["Sheet1", ["Name"]]]),
    );

    const source: WebhookSource = {
      id: "webhook_arr",
      type: "webhook",
      columns: { Name: "$.name" },
    };

    const payload = [{ name: "Alice" }, { name: "Bob" }];

    const result = await executeWebhookSource(source, payload, {
      adapter,
      ref: REF,
      env: {},
    });

    expect(result.rowsCreated).toBe(2);
  });

  it("deduplicates webhook payloads", async () => {
    const existingRows: Row[] = [{ Name: "Alice", Email: "alice@acme.com" }];
    const adapter = new MockAdapter(
      new Map([["Sheet1", existingRows]]),
      new Map([["Sheet1", ["Name", "Email"]]]),
    );

    const source: WebhookSource = {
      id: "webhook_dedup",
      type: "webhook",
      columns: { Name: "$.name", Email: "$.email" },
      dedup: "Email",
    };

    const payload = { name: "Alice New", email: "alice@acme.com" };

    const result = await executeWebhookSource(source, payload, {
      adapter,
      ref: REF,
      env: {},
    });

    expect(result.rowsSkipped).toBe(1);
    expect(result.rowsCreated).toBe(0);
  });
});
