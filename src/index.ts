// Rowbound - Google Sheets enrichment engine
// Re-exports for programmatic usage

export { SheetsAdapter } from "./adapters/sheets/sheets-adapter.js";
export { flattenItem, forceText } from "./core/cell-utils.js";
export { evaluateCondition } from "./core/condition.js";
export {
  type RunPipelineOptions,
  type RunResult,
  runPipeline,
} from "./core/engine.js";
export {
  type ExecResult,
  executeCommand,
  executeExecAction,
} from "./core/exec.js";
export { extractValue } from "./core/extractor.js";
export {
  type HttpRequestOptions,
  type HttpResponse,
  httpRequest,
  StopProviderError,
} from "./core/http-client.js";
export { executeLookup, type LookupOptions } from "./core/lookup.js";
export { RateLimiter } from "./core/rate-limiter.js";
export {
  cleanupOrphanedRanges,
  type ReconcileResult,
  reconcile,
} from "./core/reconcile.js";
export {
  formatAge,
  formatDuration,
  formatRunDetail,
  formatRunList,
} from "./core/run-format.js";
export {
  type ActionSummary,
  createRunState,
  listRuns,
  pruneRuns,
  type RunError,
  type RunState,
  readRunState,
  writeRunState,
} from "./core/run-state.js";
export { createRunTracker } from "./core/run-tracker.js";
export {
  executeSource,
  executeWebhookSource,
  type SourceOptions,
} from "./core/source.js";
export {
  isSourceDue,
  readScheduleState,
  type ScheduleEntry,
  type ScheduleState,
  updateScheduleEntry,
} from "./core/source-schedule.js";
export { resolveObject, resolveTemplate } from "./core/template.js";
export type {
  Action,
  Adapter,
  CellUpdate,
  ExecAction,
  ExecSource,
  HttpAction,
  HttpSource,
  LookupAction,
  OnErrorConfig,
  PipelineConfig,
  PipelineSettings,
  Row,
  SheetRef,
  Source,
  SourceResult,
  TabConfig,
  TransformAction,
  WaterfallAction,
  WaterfallProvider,
  WebhookSource,
  WriteAction,
} from "./core/types.js";
export {
  type ValidationResult,
  validateConfig,
} from "./core/validator.js";
export {
  executeWaterfall,
  type WaterfallResult,
} from "./core/waterfall.js";
export { executeWrite, type WriteOptions } from "./core/write-action.js";
