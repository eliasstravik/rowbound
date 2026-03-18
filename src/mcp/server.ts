import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { SheetsAdapter } from "../adapters/sheets/sheets-adapter.js";
import { defaultSettings } from "../core/defaults.js";
import { runPipeline } from "../core/engine.js";
import { buildSafeEnv } from "../core/env.js";
import { cleanupOrphanedRanges, reconcile } from "../core/reconcile.js";
import { formatRunDetail, formatRunList } from "../core/run-format.js";
import { listRuns, readRunState } from "../core/run-state.js";
import { safeCompare } from "../core/safe-compare.js";
import { getTabConfig } from "../core/tab-resolver.js";
import type { Action, PipelineConfig, SheetRef } from "../core/types.js";
import { validateConfig } from "../core/validator.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

// ---------------------------------------------------------------------------
// Rate limiter — simple in-memory per-IP sliding window (60 req/min)
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

function createRateLimiter(): (ip: string) => boolean {
  const hits = new Map<string, number[]>();

  return (ip: string): boolean => {
    const now = Date.now();
    const timestamps = hits.get(ip) ?? [];
    const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX) {
      hits.set(ip, recent);
      return false; // rate limited
    }
    recent.push(now);
    hits.set(ip, recent);
    return true; // allowed
  };
}

function getClientIp(req: IncomingMessage): string {
  return (
    req.socket.remoteAddress ??
    req.headers["x-forwarded-for"]?.toString() ??
    "unknown"
  );
}

// ---------------------------------------------------------------------------
// Shared state for watch mode
// ---------------------------------------------------------------------------

let watchController: AbortController | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRef(sheet: string, tab?: string): SheetRef {
  return { spreadsheetId: sheet, sheetName: tab ?? "Sheet1" };
}

function ok(text: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text" as const, text }] };
}

function err(error: unknown): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  return {
    content: [
      {
        type: "text" as const,
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Shared Zod schema for action_config (used by add_action)
// ---------------------------------------------------------------------------

const actionConfigSchema = z
  .object({
    id: z.string().describe("Unique action identifier"),
    type: z
      .enum(["http", "transform", "exec", "waterfall"])
      .describe("Action type"),
    target: z.string().describe("Target column to write results to"),
    when: z
      .string()
      .optional()
      .describe("Condition expression for when to run this action"),
    method: z.string().optional().describe("HTTP method (GET, POST, etc.)"),
    url: z.string().optional().describe("URL template for HTTP requests"),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("HTTP headers"),
    body: z.any().optional().describe("HTTP request body"),
    extract: z
      .string()
      .optional()
      .describe("JSONPath or expression to extract from response"),
    expression: z.string().optional().describe("Transform expression"),
    command: z.string().optional().describe("Shell command to execute"),
    timeout: z.number().optional().describe("Timeout in milliseconds"),
    providers: z.array(z.any()).optional().describe("Waterfall providers list"),
    onError: z
      .record(z.string(), z.any())
      .optional()
      .describe("Error handling configuration"),
  })
  .passthrough();

const actionPatchSchema = z
  .object({
    id: z
      .string()
      .optional()
      .describe("New action identifier (renames the action)"),
    type: z
      .enum(["http", "transform", "exec", "waterfall"])
      .optional()
      .describe("Action type"),
    target: z.string().optional().describe("Target column to write results to"),
    when: z
      .string()
      .optional()
      .describe("Condition expression for when to run this action"),
    method: z.string().optional().describe("HTTP method (GET, POST, etc.)"),
    url: z.string().optional().describe("URL template for HTTP requests"),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("HTTP headers"),
    body: z.any().optional().describe("HTTP request body"),
    extract: z
      .string()
      .optional()
      .describe("JSONPath or expression to extract from response"),
    expression: z.string().optional().describe("Transform expression"),
    command: z.string().optional().describe("Shell command to execute"),
    timeout: z.number().optional().describe("Timeout in milliseconds"),
    providers: z.array(z.any()).optional().describe("Waterfall providers list"),
    onError: z
      .record(z.string(), z.any())
      .optional()
      .describe("Error handling configuration"),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "rowbound",
  version: pkg.version,
});

// Shared adapter instance — enables header cache reuse across MCP calls
const adapter = new SheetsAdapter();

// ---------------------------------------------------------------------------
// 1. init_pipeline
// ---------------------------------------------------------------------------

server.registerTool(
  "init_pipeline",
  {
    description:
      "Initialize a Google Sheet with a default Rowbound pipeline config stored in Developer Metadata.",
    inputSchema: z.object({
      sheet: z.string().describe("Google Sheets spreadsheet ID"),
      tab: z.string().optional().describe("Sheet tab name (default: Sheet1)"),
    }),
  },
  async ({ sheet, tab }) => {
    try {
      const ref = buildRef(sheet, tab);

      const existing = await adapter.readConfig(ref);
      if (existing) {
        return err(
          "Config already exists for this sheet. Remove it first or use get_config to inspect.",
        );
      }

      const tabName = tab ?? "Sheet1";
      const sheets = await adapter.listSheets(sheet);
      const targetSheet = sheets.find((s) => s.name === tabName);
      if (!targetSheet) {
        return err(
          `Tab "${tabName}" not found. Available: ${sheets.map((s) => s.name).join(", ")}`,
        );
      }

      const gid = String(targetSheet.gid);

      const defaultConfig: PipelineConfig = {
        version: "2",
        tabs: {
          [gid]: {
            name: tabName,
            columns: {},
            actions: [],
          },
        },
        actions: [],
        settings: defaultSettings,
      };

      await adapter.writeConfig(ref, defaultConfig);
      return ok(
        `Initialized Rowbound config for sheet ${sheet} (tab: ${tabName}, GID: ${gid}).`,
      );
    } catch (error) {
      return err(error);
    }
  },
);

// ---------------------------------------------------------------------------
// 2. run_pipeline
// ---------------------------------------------------------------------------

server.registerTool(
  "run_pipeline",
  {
    description:
      "Run the enrichment pipeline on a Google Sheet. Returns a summary of rows processed, updates made, and errors.",
    inputSchema: z.object({
      sheet: z.string().describe("Google Sheets spreadsheet ID"),
      tab: z.string().optional().describe("Sheet tab name"),
      rows: z.string().optional().describe("Row range to process, e.g. '2-50'"),
      action: z
        .string()
        .optional()
        .describe("Run only a specific action by ID"),
      dry: z
        .boolean()
        .optional()
        .describe("Dry run — compute but do not write back"),
    }),
  },
  async ({ sheet, tab, rows, action, dry }) => {
    try {
      const ref = buildRef(sheet, tab);

      const config = await adapter.readConfig(ref);
      if (!config) {
        return err("No Rowbound config found. Run init_pipeline first.");
      }

      const reconciled = await reconcile(adapter, ref, config);
      if (reconciled.configChanged) {
        await adapter.writeConfig(ref, reconciled.config);
      }
      if (reconciled.orphanedRanges.length > 0) {
        await cleanupOrphanedRanges(adapter, ref, reconciled.orphanedRanges);
      }

      const tabConfig = reconciled.tabConfig;

      if (tabConfig.actions.length === 0) {
        return err("No actions configured. Add actions with add_action first.");
      }

      if (rows && !/^\d+-\d+$/.test(rows)) {
        return err("Invalid rows format. Expected e.g. '2-50'.");
      }
      if (action && !tabConfig.actions.some((s) => s.id === action)) {
        return err(
          `Action "${action}" not found. Available: ${tabConfig.actions.map((s) => s.id).join(", ")}`,
        );
      }

      const range = rows ? rows.replace("-", ":") : undefined;
      const resolvedConfig = {
        ...reconciled.config,
        actions: tabConfig.actions,
      };
      const env = buildSafeEnv(resolvedConfig);

      const result = await runPipeline({
        adapter,
        ref,
        config: resolvedConfig,
        env,
        range,
        actionFilter: action,
        dryRun: dry ?? false,
        columnMap: tabConfig.columns,
      });

      const output: Record<string, unknown> = { ...result };
      if (reconciled.messages.length > 0) {
        output.columnMessages = reconciled.messages;
      }

      return ok(JSON.stringify(output, null, 2));
    } catch (error) {
      return err(error);
    }
  },
);

// ---------------------------------------------------------------------------
// 3. add_action
// ---------------------------------------------------------------------------

server.registerTool(
  "add_action",
  {
    description:
      "Add an action to the pipeline config. Provide the action definition as a structured object.",
    inputSchema: z.object({
      sheet: z.string().describe("Google Sheets spreadsheet ID"),
      tab: z.string().optional().describe("Sheet tab name"),
      action_config: actionConfigSchema.describe(
        "Action definition (must include id, type, and target)",
      ),
    }),
  },
  async ({ sheet, tab, action_config }) => {
    try {
      const ref = buildRef(sheet, tab);

      const action = action_config as Action;

      const existing = await adapter.readConfig(ref);
      if (!existing) {
        return err("No Rowbound config found. Run init_pipeline first.");
      }

      if (existing.tabs) {
        const { gid, tab: tabCfg } = getTabConfig(existing, tab);
        if (tabCfg.actions.some((s) => s.id === action.id)) {
          return err(`Action with id "${action.id}" already exists.`);
        }
        tabCfg.actions.push(action);
        existing.tabs[gid] = tabCfg;
      } else {
        if (existing.actions.some((s) => s.id === action.id)) {
          return err(`Action with id "${action.id}" already exists.`);
        }
        existing.actions.push(action);
      }

      await adapter.writeConfig(ref, existing);

      // Validate config and include warnings if any
      const validation = validateConfig(existing);
      const warnings = [...validation.errors, ...validation.warnings];
      if (warnings.length > 0) {
        return ok(
          `Added action "${action.id}" (${action.type} -> ${action.target}).\n\nValidation warnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`,
        );
      }

      return ok(
        `Added action "${action.id}" (${action.type} -> ${action.target}).`,
      );
    } catch (error) {
      return err(error);
    }
  },
);

// ---------------------------------------------------------------------------
// 4. remove_action
// ---------------------------------------------------------------------------

server.registerTool(
  "remove_action",
  {
    description: "Remove an action from the pipeline config by its ID.",
    inputSchema: z.object({
      sheet: z.string().describe("Google Sheets spreadsheet ID"),
      tab: z.string().optional().describe("Sheet tab name"),
      action_id: z.string().describe("ID of the action to remove"),
    }),
  },
  async ({ sheet, tab, action_id }) => {
    try {
      const ref = buildRef(sheet, tab);

      const existing = await adapter.readConfig(ref);
      if (!existing) {
        return err("No Rowbound config found. Run init_pipeline first.");
      }

      if (existing.tabs) {
        const { gid, tab: tabCfg } = getTabConfig(existing, tab);
        const originalLength = tabCfg.actions.length;
        tabCfg.actions = tabCfg.actions.filter((s) => s.id !== action_id);
        if (tabCfg.actions.length === originalLength) {
          return err(`Action "${action_id}" not found in config.`);
        }
        existing.tabs[gid] = tabCfg;
      } else {
        const originalLength = existing.actions.length;
        existing.actions = existing.actions.filter((s) => s.id !== action_id);
        if (existing.actions.length === originalLength) {
          return err(`Action "${action_id}" not found in config.`);
        }
      }

      await adapter.writeConfig(ref, existing);
      return ok(`Removed action "${action_id}".`);
    } catch (error) {
      return err(error);
    }
  },
);

// ---------------------------------------------------------------------------
// 5. update_action
// ---------------------------------------------------------------------------

server.registerTool(
  "update_action",
  {
    description:
      "Update an existing action by merging a partial definition. Can rename IDs, change targets, expressions, etc.",
    inputSchema: z.object({
      sheet: z.string().describe("Google Sheets spreadsheet ID"),
      tab: z.string().optional().describe("Sheet tab name"),
      action_id: z.string().describe("ID of the action to update"),
      patch: actionPatchSchema.describe(
        "Partial action definition to merge into the existing action",
      ),
    }),
  },
  async ({ sheet, tab, action_id, patch }) => {
    try {
      const ref = buildRef(sheet, tab);

      const existing = await adapter.readConfig(ref);
      if (!existing) {
        return err("No Rowbound config found. Run init_pipeline first.");
      }

      let actions: Action[];
      let gid: string | undefined;
      if (existing.tabs) {
        const resolved = getTabConfig(existing, tab);
        gid = resolved.gid;
        actions = resolved.tab.actions;
      } else {
        actions = existing.actions;
      }

      const actionIndex = actions.findIndex((s) => s.id === action_id);
      if (actionIndex === -1) {
        return err(`Action "${action_id}" not found in config.`);
      }

      if (patch.id && patch.id !== action_id) {
        if (actions.some((s) => s.id === patch.id)) {
          return err(`Action with id "${patch.id}" already exists.`);
        }
      }

      actions[actionIndex] = { ...actions[actionIndex]!, ...patch } as Action;

      if (existing.tabs && gid) {
        existing.tabs[gid]!.actions = actions;
      } else {
        existing.actions = actions;
      }

      await adapter.writeConfig(ref, existing);

      // Validate config and include warnings if any
      const validation = validateConfig(existing);
      const validationWarnings = [...validation.errors, ...validation.warnings];
      const msg = `Updated action "${action_id}"${patch.id && patch.id !== action_id ? ` → "${patch.id}"` : ""}.`;
      if (validationWarnings.length > 0) {
        return ok(
          `${msg}\n\nValidation warnings:\n${validationWarnings.map((w) => `- ${w}`).join("\n")}`,
        );
      }

      return ok(msg);
    } catch (error) {
      return err(error);
    }
  },
);

// ---------------------------------------------------------------------------
// 6. update_settings
// ---------------------------------------------------------------------------

server.registerTool(
  "update_settings",
  {
    description:
      "Update pipeline settings (concurrency, rate limit, retry attempts, retry backoff).",
    inputSchema: z.object({
      sheet: z.string().describe("Google Sheets spreadsheet ID"),
      tab: z.string().optional().describe("Sheet tab name"),
      concurrency: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max concurrent rows"),
      rate_limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max requests per second"),
      retry_attempts: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Number of retry attempts"),
      retry_backoff: z
        .enum(["exponential", "linear", "fixed"])
        .optional()
        .describe("Backoff strategy (exponential, linear, fixed)"),
    }),
  },
  async ({
    sheet,
    tab,
    concurrency,
    rate_limit,
    retry_attempts,
    retry_backoff,
  }) => {
    try {
      const ref = buildRef(sheet, tab);

      const existing = await adapter.readConfig(ref);
      if (!existing) {
        return err("No Rowbound config found. Run init_pipeline first.");
      }

      const changes: string[] = [];

      if (concurrency !== undefined) {
        existing.settings.concurrency = concurrency;
        changes.push(`concurrency=${concurrency}`);
      }
      if (rate_limit !== undefined) {
        existing.settings.rateLimit = rate_limit;
        changes.push(`rateLimit=${rate_limit}`);
      }
      if (retry_attempts !== undefined) {
        existing.settings.retryAttempts = retry_attempts;
        changes.push(`retryAttempts=${retry_attempts}`);
      }
      if (retry_backoff !== undefined) {
        existing.settings.retryBackoff = retry_backoff;
        changes.push(`retryBackoff=${retry_backoff}`);
      }

      if (changes.length === 0) {
        return err(
          "No settings provided. Specify at least one setting to update.",
        );
      }

      await adapter.writeConfig(ref, existing);
      return ok(`Updated settings: ${changes.join(", ")}`);
    } catch (error) {
      return err(error);
    }
  },
);

// ---------------------------------------------------------------------------
// 7. sync_columns
// ---------------------------------------------------------------------------

server.registerTool(
  "sync_columns",
  {
    description:
      "Sync the column registry with the current sheet state — reconcile renames, track new columns, remove deleted ones, and migrate action targets to IDs.",
    inputSchema: z.object({
      sheet: z.string().describe("Google Sheets spreadsheet ID"),
      tab: z.string().optional().describe("Sheet tab name"),
    }),
  },
  async ({ sheet, tab }) => {
    try {
      const ref = buildRef(sheet, tab);

      const config = await adapter.readConfig(ref);
      if (!config) {
        return err("No Rowbound config found. Run init_pipeline first.");
      }

      const reconciled = await reconcile(adapter, ref, config);

      if (reconciled.configChanged) {
        await adapter.writeConfig(ref, reconciled.config);
      }
      if (reconciled.orphanedRanges.length > 0) {
        await cleanupOrphanedRanges(adapter, ref, reconciled.orphanedRanges);
      }

      const tabConfig = reconciled.tabConfig;
      const cols = Object.keys(tabConfig.columns).length;
      const actions = tabConfig.actions.length;
      const output: Record<string, unknown> = {
        columnsTracked: cols,
        actionsConfigured: actions,
        tabGid: reconciled.tabGid,
        tabName: tabConfig.name,
        changed: reconciled.configChanged,
      };

      if (reconciled.messages.length > 0) {
        output.messages = reconciled.messages;
      }

      return ok(JSON.stringify(output, null, 2));
    } catch (error) {
      return err(error);
    }
  },
);

// ---------------------------------------------------------------------------
// 8. get_config
// ---------------------------------------------------------------------------

server.registerTool(
  "get_config",
  {
    description: "Return the current pipeline config as formatted JSON.",
    inputSchema: z.object({
      sheet: z.string().describe("Google Sheets spreadsheet ID"),
      tab: z.string().optional().describe("Sheet tab name"),
    }),
  },
  async ({ sheet, tab }) => {
    try {
      const ref = buildRef(sheet, tab);

      const config = await adapter.readConfig(ref);
      if (!config) {
        return err("No Rowbound config found for this sheet.");
      }

      return ok(JSON.stringify(config, null, 2));
    } catch (error) {
      return err(error);
    }
  },
);

// ---------------------------------------------------------------------------
// 9. validate_config
// ---------------------------------------------------------------------------

server.registerTool(
  "validate_config",
  {
    description: "Validate the pipeline config and return validation results.",
    inputSchema: z.object({
      sheet: z.string().describe("Google Sheets spreadsheet ID"),
      tab: z.string().optional().describe("Sheet tab name"),
    }),
  },
  async ({ sheet, tab }) => {
    try {
      const ref = buildRef(sheet, tab);

      const config = await adapter.readConfig(ref);
      if (!config) {
        return err("No Rowbound config found for this sheet.");
      }

      let validationConfig = config;
      let actionCount = config.actions.length;
      if (config.tabs) {
        const { tab: tabCfg } = getTabConfig(config, tab);
        validationConfig = { ...config, actions: tabCfg.actions };
        actionCount = tabCfg.actions.length;
      }

      const result = validateConfig(validationConfig);

      if (result.valid) {
        return ok(
          JSON.stringify(
            {
              valid: true,
              version: config.version,
              actionCount,
              settings: config.settings,
              warnings:
                result.warnings.length > 0 ? result.warnings : undefined,
            },
            null,
            2,
          ),
        );
      } else {
        return ok(
          JSON.stringify(
            {
              valid: false,
              errors: result.errors,
              warnings:
                result.warnings.length > 0 ? result.warnings : undefined,
            },
            null,
            2,
          ),
        );
      }
    } catch (error) {
      return err(error);
    }
  },
);

// ---------------------------------------------------------------------------
// 10. get_status
// ---------------------------------------------------------------------------

server.registerTool(
  "get_status",
  {
    description:
      "Return pipeline status: action count, settings, and enrichment rates per target column.",
    inputSchema: z.object({
      sheet: z.string().describe("Google Sheets spreadsheet ID"),
      tab: z.string().optional().describe("Sheet tab name"),
    }),
  },
  async ({ sheet, tab }) => {
    try {
      const ref = buildRef(sheet, tab);

      const config = await adapter.readConfig(ref);
      if (!config) {
        return err("No Rowbound config found. Run init_pipeline first.");
      }

      let actions: Action[];
      if (config.tabs) {
        const { tab: tabCfg } = getTabConfig(config, tab);
        actions = tabCfg.actions;
      } else {
        actions = config.actions;
      }

      const status: Record<string, unknown> = {
        actions: actions.map((s) => ({
          id: s.id,
          type: s.type,
          target: s.target,
        })),
        settings: config.settings,
      };

      try {
        const rows = await adapter.readRows(ref);
        const targetColumns = [...new Set(actions.map((s) => s.target))];

        status.totalRows = rows.length;
        status.enrichment = targetColumns.map((target) => {
          const filled = rows.filter(
            (row) => row[target] !== undefined && row[target] !== "",
          ).length;
          const pct =
            rows.length > 0 ? Math.round((filled / rows.length) * 100) : 0;
          return { column: target, filled, total: rows.length, percent: pct };
        });
      } catch {
        status.dataError = "Could not read sheet data for enrichment status.";
      }

      return ok(JSON.stringify(status, null, 2));
    } catch (error) {
      return err(error);
    }
  },
);

// ---------------------------------------------------------------------------
// 11. dry_run
// ---------------------------------------------------------------------------

server.registerTool(
  "dry_run",
  {
    description:
      "Run the pipeline in dry mode — compute what would be changed without writing back to the sheet.",
    inputSchema: z.object({
      sheet: z.string().describe("Google Sheets spreadsheet ID"),
      tab: z.string().optional().describe("Sheet tab name"),
      rows: z.string().optional().describe("Row range to process, e.g. '2-50'"),
    }),
  },
  async ({ sheet, tab, rows }) => {
    try {
      const ref = buildRef(sheet, tab);

      const config = await adapter.readConfig(ref);
      if (!config) {
        return err("No Rowbound config found. Run init_pipeline first.");
      }

      const reconciled = await reconcile(adapter, ref, config);
      const tabConfig = reconciled.tabConfig;

      if (tabConfig.actions.length === 0) {
        return err("No actions configured. Add actions with add_action first.");
      }

      if (rows && !/^\d+-\d+$/.test(rows)) {
        return err("Invalid rows format. Expected e.g. '2-50'.");
      }

      const range = rows ? rows.replace("-", ":") : undefined;
      const resolvedConfig = {
        ...reconciled.config,
        actions: tabConfig.actions,
      };
      const env = buildSafeEnv(resolvedConfig);

      const result = await runPipeline({
        adapter,
        ref,
        config: resolvedConfig,
        env,
        range,
        dryRun: true,
        columnMap: tabConfig.columns,
      });

      const output: Record<string, unknown> = { dryRun: true, ...result };
      if (reconciled.messages.length > 0) {
        output.columnMessages = reconciled.messages;
      }

      return ok(JSON.stringify(output, null, 2));
    } catch (error) {
      return err(error);
    }
  },
);

// ---------------------------------------------------------------------------
// 12. start_watch
// ---------------------------------------------------------------------------

server.registerTool(
  "start_watch",
  {
    description:
      "Start watch mode — poll the sheet on an interval and optionally run a webhook server. This blocks the tool call until stopped.",
    inputSchema: z.object({
      sheet: z.string().describe("Google Sheets spreadsheet ID"),
      tab: z.string().optional().describe("Sheet tab name"),
      interval: z
        .number()
        .optional()
        .describe("Polling interval in seconds (default: 30)"),
      port: z
        .number()
        .optional()
        .describe("Webhook server port (default: 3000)"),
    }),
  },
  async ({ sheet, tab, interval, port }) => {
    try {
      if (watchController) {
        return err("Watch mode is already running. Call stop_watch first.");
      }

      const ref = buildRef(sheet, tab);

      const config = await adapter.readConfig(ref);
      if (!config) {
        return err("No Rowbound config found. Run init_pipeline first.");
      }

      const hasActions = config.tabs
        ? Object.values(config.tabs).some((t) => t.actions.length > 0)
        : config.actions.length > 0;
      if (!hasActions) {
        return err("No actions configured. Add actions with add_action first.");
      }

      const intervalSeconds = interval ?? 30;
      const webhookPort = port ?? 3000;
      const webhookToken = process.env.ROWBOUND_WEBHOOK_TOKEN;

      watchController = new AbortController();
      const controller = watchController;
      let isRunning = false;

      async function runOnce(): Promise<void> {
        if (isRunning || controller.signal.aborted) return;
        isRunning = true;
        try {
          const freshConfig = await adapter.readConfig(ref);
          const activeConfig = freshConfig ?? config!;

          const env = buildSafeEnv(activeConfig);

          const reconciled = await reconcile(adapter, ref, activeConfig);
          if (reconciled.configChanged) {
            await adapter.writeConfig(ref, reconciled.config);
          }
          if (reconciled.orphanedRanges.length > 0) {
            await cleanupOrphanedRanges(
              adapter,
              ref,
              reconciled.orphanedRanges,
            );
          }

          const tabCfg = reconciled.tabConfig;
          const resolvedConfig = {
            ...reconciled.config,
            actions: tabCfg.actions,
          };

          await runPipeline({
            adapter,
            ref,
            config: resolvedConfig,
            env,
            signal: controller.signal,
            columnMap: tabCfg.columns,
          });
        } finally {
          isRunning = false;
        }
      }

      // Immediate first run (matches CLI watch behavior)
      try {
        await runOnce();
      } catch {
        // Don't prevent the interval from starting
      }

      // Start polling loop
      const intervalId = setInterval(async () => {
        if (controller.signal.aborted) return;
        try {
          await runOnce();
        } catch (error) {
          console.error(
            `[watch] Poll error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }, intervalSeconds * 1000);

      // Start webhook server
      const { createServer } = await import("node:http");
      const isAllowed = createRateLimiter();
      const httpServer = createServer(async (req, res) => {
        const ip = getClientIp(req);
        if (!isAllowed(ip)) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Too Many Requests" }));
          return;
        }

        if (req.method !== "POST" || req.url !== "/webhook") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
          return;
        }

        if (webhookToken) {
          const authHeader = req.headers.authorization ?? "";
          if (!safeCompare(authHeader, `Bearer ${webhookToken}`)) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return;
          }
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        for await (const chunk of req) {
          totalBytes += (chunk as Buffer).length;
          if (totalBytes > 1_048_576) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Payload too large" }));
            return;
          }
          chunks.push(chunk as Buffer);
        }

        try {
          await runOnce();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: msg }));
        }
      });

      httpServer.headersTimeout = 10_000;
      httpServer.requestTimeout = 30_000;
      httpServer.keepAliveTimeout = 5_000;

      httpServer.listen(webhookPort, "127.0.0.1");

      // Wait until aborted
      try {
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener("abort", () => {
            clearInterval(intervalId);
            httpServer.close();
            resolve();
          });
        });
      } finally {
        watchController = null;
      }

      return ok(
        `Watch mode stopped. Was polling sheet ${sheet} every ${intervalSeconds}s with webhook on port ${webhookPort}.`,
      );
    } catch (error) {
      watchController = null;
      return err(error);
    }
  },
);

// ---------------------------------------------------------------------------
// 13. stop_watch
// ---------------------------------------------------------------------------

server.registerTool(
  "stop_watch",
  {
    description: "Stop watch mode if it is currently running.",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      if (!watchController) {
        return ok("Watch mode is not running.");
      }

      watchController.abort();
      return ok("Watch mode stopped.");
    } catch (error) {
      return err(error);
    }
  },
);

// ---------------------------------------------------------------------------
// 14. preview_rows
// ---------------------------------------------------------------------------

server.registerTool(
  "preview_rows",
  {
    description:
      "Read rows from the sheet and return them as formatted text. Useful for inspecting data before running the pipeline.",
    inputSchema: z.object({
      sheet: z.string().describe("Google Sheets spreadsheet ID"),
      tab: z.string().optional().describe("Sheet tab name"),
      range: z
        .string()
        .optional()
        .describe('Sheet range to read (e.g. "A1:D10")'),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of data rows to return (default: 10)"),
    }),
  },
  async ({ sheet, tab, range, limit }) => {
    try {
      const ref: SheetRef = { spreadsheetId: sheet, sheetName: tab };

      const rows = range
        ? await adapter.readRows(ref, range)
        : await adapter.readRows(ref);

      const maxRows = limit ?? 10;
      const sliced = rows.slice(0, maxRows);

      if (sliced.length === 0) {
        return ok("No data rows found.");
      }

      const headers = Object.keys(sliced[0]!);
      const lines: string[] = [headers.join("\t")];
      for (const row of sliced) {
        lines.push(headers.map((h) => row[h] ?? "").join("\t"));
      }

      const summary =
        rows.length > maxRows
          ? `\n\n(Showing ${maxRows} of ${rows.length} rows)`
          : `\n\n(${rows.length} rows total)`;

      return ok(lines.join("\n") + summary);
    } catch (error) {
      return err(error);
    }
  },
);

// ---------------------------------------------------------------------------
// 15. list_runs
// ---------------------------------------------------------------------------

server.registerTool(
  "list_runs",
  {
    description:
      "List recent pipeline runs with status, duration, and error counts",
    inputSchema: z.object({
      sheet: z.string().optional().describe("Filter by Google Sheet ID"),
      limit: z.number().optional().describe("Max runs to return (default 20)"),
    }),
  },
  async ({ sheet, limit }) => {
    try {
      const runs = await listRuns({ sheetId: sheet, limit });
      return ok(formatRunList(runs));
    } catch (error) {
      return err(error);
    }
  },
);

// ---------------------------------------------------------------------------
// 16. get_run
// ---------------------------------------------------------------------------

server.registerTool(
  "get_run",
  {
    description:
      "Get detailed status of a specific pipeline run including action summaries and errors",
    inputSchema: z.object({
      run_id: z.string().optional().describe("Run ID to view"),
      last: z.boolean().optional().describe("View the most recent run"),
      errors_only: z.boolean().optional().describe("Show only errors"),
    }),
  },
  async ({ run_id, last, errors_only }) => {
    try {
      let run: Awaited<ReturnType<typeof readRunState>> | undefined;

      if (run_id) {
        run = await readRunState(run_id);
        if (!run) {
          return err(`Run "${run_id}" not found.`);
        }
      } else if (last) {
        const runs = await listRuns({ limit: 1 });
        if (runs.length === 0) {
          return err("No runs found.");
        }
        run = runs[0]!;
      } else {
        return err("Provide either run_id or set last=true.");
      }

      return ok(formatRunDetail(run, errors_only ?? false));
    } catch (error) {
      return err(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Export startup function
// ---------------------------------------------------------------------------

export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
