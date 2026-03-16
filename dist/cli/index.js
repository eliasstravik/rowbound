#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import dotenv from "dotenv";
import { registerConfig } from "./config.js";
import { getGlobalEnvPath, registerEnv } from "./env.js";
import { registerInit } from "./init.js";
import { registerRun } from "./run.js";
import { registerRuns } from "./runs.js";
import { registerStatus } from "./status.js";
import { registerSync } from "./sync.js";
import { registerWatch } from "./watch.js";
// Load local .env first (higher priority), then global ~/.config/rowbound/.env
// dotenv never overwrites existing process.env, so shell vars always win
dotenv.config();
dotenv.config({ path: getGlobalEnvPath() });
const require = createRequire(import.meta.url);
const pkg = require("../../package.json");
const program = new Command();
program
    .name("rowbound")
    .description("Open-source CLI for Google Sheets enrichment — waterfalls, conditions, HTTP API integrations")
    .version(pkg.version);
registerInit(program);
registerRun(program);
registerConfig(program);
registerStatus(program);
registerWatch(program);
registerRuns(program);
registerSync(program);
registerEnv(program);
program
    .command("mcp")
    .description("Start MCP server (stdio)")
    .action(async () => {
    const { startMcpServer } = await import("../mcp/server.js");
    await startMcpServer();
});
program.parse(process.argv);
