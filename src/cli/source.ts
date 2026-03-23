import type { Command } from "commander";
import { SheetsAdapter } from "../adapters/sheets/sheets-adapter.js";
import { buildSafeEnv } from "../core/env.js";
import { RateLimiter } from "../core/rate-limiter.js";
import { reconcile } from "../core/reconcile.js";
import { resolveScript } from "../core/script.js";
import { executeSource } from "../core/source.js";
import {
  readScheduleState,
  scheduleKey,
  updateScheduleEntry,
} from "../core/source-schedule.js";
import type { Source } from "../core/types.js";
import { bold, dim, error, success, warn } from "./format.js";

export function registerSource(program: Command): void {
  const source = program
    .command("source")
    .description("Manage and run data sources");

  source
    .command("run")
    .description("Run a source to populate rows from external data")
    .argument("<sheetId>", "Google Sheets spreadsheet ID")
    .option("--tab <name>", "Sheet tab name", "Sheet1")
    .option("--source <id>", "Source ID to run (required)")
    .option("--dry-run", "Preview without writing", false)
    .option("--json", "Output result as JSON")
    .action(
      async (
        sheetId: string,
        opts: {
          tab: string;
          source?: string;
          dryRun: boolean;
          json: boolean;
        },
      ) => {
        const adapter = new SheetsAdapter();
        const ref = { spreadsheetId: sheetId, sheetName: opts.tab };
        const jsonMode = opts.json ?? false;

        const log = (msg: string) => {
          if (!jsonMode) console.log(msg);
        };
        const logErr = (msg: string) => {
          if (!jsonMode) console.error(msg);
        };

        try {
          const config = await adapter.readConfig(ref);
          if (!config) {
            logErr(
              `${error("No Rowbound config found.")} Run 'rowbound init <sheetId>' first.`,
            );
            process.exitCode = 1;
            return;
          }

          const reconciled = await reconcile(adapter, ref, config);
          if (reconciled.configChanged) {
            await adapter.writeConfig(ref, reconciled.config);
          }

          const tabConfig = reconciled.tabConfig;
          const sources = tabConfig.sources ?? [];

          if (sources.length === 0) {
            logErr(
              `${error("No sources configured.")} Add sources with 'rowbound config add-source'.`,
            );
            process.exitCode = 1;
            return;
          }

          // Find source to run
          let sourcesToRun: Source[];
          if (opts.source) {
            const found = sources.find((s) => s.id === opts.source);
            if (!found) {
              logErr(
                `${error(`Source "${opts.source}" not found.`)} Available: ${sources.map((s) => s.id).join(", ")}`,
              );
              process.exitCode = 1;
              return;
            }
            sourcesToRun = [found];
          } else {
            sourcesToRun = sources;
          }

          const resolvedConfig = {
            ...reconciled.config,
            actions: tabConfig.actions,
            sources,
          };
          const env = buildSafeEnv(resolvedConfig);

          const rateLimiter =
            reconciled.config.settings.rateLimit > 0
              ? new RateLimiter(reconciled.config.settings.rateLimit * 1000)
              : undefined;

          if (opts.dryRun) {
            log(warn("DRY RUN — no writes will be made\n"));
          }

          for (const src of sourcesToRun) {
            log(`Running source ${bold(src.id)} (${src.type})...`);

            const result = await executeSource(src, {
              adapter,
              ref,
              env,
              dryRun: opts.dryRun,
              resolveScript: (name: string) =>
                resolveScript(name, reconciled.config, tabConfig),
              rateLimiter,
              retryAttempts: reconciled.config.settings.retryAttempts ?? 0,
              retryBackoff: reconciled.config.settings.retryBackoff,
            });

            // Update schedule tracking
            const tabGid = reconciled.tabGid ?? "0";
            updateScheduleEntry(
              sheetId,
              tabGid,
              src.id,
              result.errors.length > 0 ? "failed" : "completed",
              result.rowsCreated,
            );

            if (jsonMode) {
              console.log(JSON.stringify(result, null, 2));
            } else {
              log(
                `  ${success("✓")} Created: ${bold(String(result.rowsCreated))}` +
                  `  Updated: ${bold(String(result.rowsUpdated))}` +
                  `  Skipped: ${dim(String(result.rowsSkipped))}` +
                  (result.errors.length > 0
                    ? `  ${error(`Errors: ${result.errors.length}`)}`
                    : ""),
              );
              if (result.errors.length > 0) {
                for (const err of result.errors) {
                  log(`  ${error("✗")} ${err}`);
                }
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (jsonMode) {
            console.log(JSON.stringify({ error: msg }, null, 2));
          } else {
            console.error(error("Source run failed:"), msg);
          }
          process.exitCode = 1;
        }
      },
    );

  source
    .command("list")
    .description("List configured sources")
    .argument("<sheetId>", "Google Sheets spreadsheet ID")
    .option("--tab <name>", "Sheet tab name", "Sheet1")
    .option("--json", "Output as JSON")
    .action(async (sheetId: string, opts: { tab: string; json: boolean }) => {
      const adapter = new SheetsAdapter();
      const ref = { spreadsheetId: sheetId, sheetName: opts.tab };

      try {
        const config = await adapter.readConfig(ref);
        if (!config) {
          console.error(error("No Rowbound config found."));
          process.exitCode = 1;
          return;
        }

        const reconciled = await reconcile(adapter, ref, config);
        const tabConfig = reconciled.tabConfig;
        const sources = tabConfig.sources ?? [];
        const state = readScheduleState();

        if (opts.json) {
          console.log(JSON.stringify(sources, null, 2));
          return;
        }

        if (sources.length === 0) {
          console.log(dim("No sources configured."));
          return;
        }

        console.log(`${bold("Sources")} (${sources.length})\n`);
        for (const src of sources) {
          const schedule =
            src.type !== "webhook"
              ? ((src as { schedule?: string }).schedule ?? "manual")
              : "webhook";
          const key = scheduleKey(sheetId, reconciled.tabGid ?? "0", src.id);
          const entry = state[key];
          const lastRun = entry
            ? `last run: ${new Date(entry.lastRunAt).toLocaleString()}`
            : "never run";

          console.log(
            `  ${bold(src.id)} (${src.type}) — ${schedule} — ${dim(lastRun)}`,
          );
          console.log(`    columns: ${Object.keys(src.columns).join(", ")}`);
          if (src.dedup) {
            console.log(
              `    dedup: ${src.dedup}${src.updateExisting ? " (update existing)" : ""}`,
            );
          }
        }
      } catch (err) {
        console.error(
          error("Failed:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exitCode = 1;
      }
    });
}
