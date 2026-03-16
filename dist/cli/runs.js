import fs from "node:fs/promises";
import { formatRunDetail, formatRunList } from "../core/run-format.js";
import { getRunsDir, listRuns, readRunState } from "../core/run-state.js";
import { dim, error, success, warn } from "./format.js";
/**
 * Colorize status icons in run format output.
 * ✓ -> green, ✗ -> red, ⚠ -> yellow, ⊘ -> dim, ⏳ -> dim
 */
function colorizeRunOutput(text) {
    return text
        .replace(/✓/g, success("✓"))
        .replace(/✗/g, error("✗"))
        .replace(/⚠/g, warn("⚠"))
        .replace(/⊘/g, dim("⊘"))
        .replace(/⏳/g, dim("⏳"));
}
export function registerRuns(program) {
    const runsCmd = program
        .command("runs")
        .description("List and inspect pipeline runs")
        .option("--sheet <id>", "Filter by sheet ID")
        .option("--limit <n>", "Number of runs to show", "20")
        .option("--json", "Output as JSON instead of table")
        .option("--last", "Show detail view of the most recent run")
        .option("--errors", "Show only errors (use with --last or a run ID)")
        .argument("[runId]", "Show detail view of a specific run")
        .action(async (runId, opts) => {
        // Detail view: specific run by ID
        if (runId) {
            const run = await readRunState(runId);
            if (!run) {
                console.error(`Run "${runId}" not found.`);
                process.exitCode = 1;
                return;
            }
            console.log(colorizeRunOutput(formatRunDetail(run, opts.errors ?? false)));
            return;
        }
        // Detail view: most recent run (--last)
        if (opts.last) {
            const runs = await listRuns({ limit: 1 });
            if (runs.length === 0) {
                console.error("No runs found.");
                process.exitCode = 1;
                return;
            }
            console.log(colorizeRunOutput(formatRunDetail(runs[0], opts.errors ?? false)));
            return;
        }
        // List view (default)
        const limit = parseInt(opts.limit, 10);
        if (Number.isNaN(limit) || limit < 1) {
            console.error("Invalid --limit value. Must be a positive integer.");
            process.exitCode = 1;
            return;
        }
        const runs = await listRuns({ sheetId: opts.sheet, limit });
        if (opts.json) {
            console.log(JSON.stringify(runs, null, 2));
            return;
        }
        console.log(colorizeRunOutput(formatRunList(runs)));
    });
    // Subcommand: rowbound runs clear
    runsCmd
        .command("clear")
        .description("Delete all run history")
        .option("-f, --force", "Skip confirmation prompt")
        .action(async (opts) => {
        const dir = await getRunsDir();
        let files;
        try {
            files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
        }
        catch {
            console.log("Deleted 0 runs.");
            return;
        }
        if (files.length === 0) {
            console.log("Deleted 0 runs.");
            return;
        }
        if (!opts.force) {
            const readline = await import("node:readline/promises");
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            const answer = await rl.question(`Delete ${files.length} run(s)? [y/N] `);
            rl.close();
            if (answer.toLowerCase() !== "y") {
                console.log("Cancelled.");
                return;
            }
        }
        let deleted = 0;
        for (const file of files) {
            try {
                await fs.unlink(`${dir}/${file}`);
                deleted++;
            }
            catch {
                // Ignore deletion errors
            }
        }
        console.log(`Deleted ${deleted} run${deleted !== 1 ? "s" : ""}.`);
    });
}
