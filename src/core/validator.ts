import vm from "node:vm";
import { JSONPath } from "jsonpath-plus";
import type {
  ExecAction,
  ExecSource,
  HttpAction,
  HttpSource,
  LookupAction,
  PipelineConfig,
  Source,
  TransformAction,
  WaterfallAction,
  WriteAction,
} from "./types.js";

/** Result of validating a PipelineConfig. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Maximum recommended config size in bytes (Developer Metadata limit is 30K). */
const CONFIG_SIZE_WARN = 25_000;

/** Allowed action types. */
const VALID_ACTION_TYPES = new Set([
  "http",
  "waterfall",
  "transform",
  "exec",
  "lookup",
  "write",
]);

/** Known retry backoff strategies. */
const KNOWN_BACKOFF = new Set(["exponential", "linear", "fixed"]);

/** Standard HTTP methods. */
const KNOWN_HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/**
 * Regex for valid template placeholders: {{row.xxx}} or {{env.XXX}}.
 * Invalid patterns are anything inside {{ }} that does NOT match this form.
 */
const VALID_TEMPLATE_REGEX = /^\{\{(row|env)\.[^}]+\}\}$/;

/** Extended regex that also allows {{item.xxx}} (for write action column templates). */
const VALID_TEMPLATE_REGEX_EXTENDED = /^\{\{(row|env|item)\.[^}]+\}\}$/;

/**
 * Finds all {{...}} patterns in a string and returns any that are invalid.
 * When `allowItem` is true, {{item.xxx}} is also accepted (used by write action column values).
 */
function findInvalidTemplates(value: string, allowItem = false): string[] {
  const TEMPLATE_REGEX = /\{\{[^}]*\}\}/g;
  const validRegex = allowItem
    ? VALID_TEMPLATE_REGEX_EXTENDED
    : VALID_TEMPLATE_REGEX;
  const invalid: string[] = [];
  for (const match of value.matchAll(TEMPLATE_REGEX)) {
    if (!validRegex.test(match[0])) {
      invalid.push(match[0]);
    }
  }
  return invalid;
}

/**
 * Recursively collect all string values from a JSON-like structure.
 */
function collectStrings(obj: unknown): string[] {
  if (typeof obj === "string") return [obj];
  if (Array.isArray(obj)) return obj.flatMap(collectStrings);
  if (obj !== null && typeof obj === "object") {
    return Object.values(obj).flatMap(collectStrings);
  }
  return [];
}

/**
 * Check whether a `when` expression can be parsed as valid JavaScript.
 * Uses vm.compileFunction which only compiles (no callable Function object).
 */
function isParseableExpression(expression: string): boolean {
  try {
    vm.compileFunction(`"use strict"; return (${expression});`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a JSONPath expression is syntactically valid.
 */
function isValidJsonPath(expression: string): boolean {
  try {
    JSONPath({ path: expression, json: {}, eval: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate template strings in url, headers, and body of an action-like object.
 */
function validateTemplates(
  label: string,
  obj: { url?: string; headers?: Record<string, string>; body?: unknown },
  errors: string[],
): void {
  // Check url
  if (obj.url) {
    const invalid = findInvalidTemplates(obj.url);
    for (const t of invalid) {
      errors.push(
        `${label}: invalid template "${t}" in url — must be {{row.x}} or {{env.X}}`,
      );
    }
  }

  // Check header values
  if (obj.headers) {
    for (const [headerKey, headerVal] of Object.entries(obj.headers)) {
      const invalid = findInvalidTemplates(headerVal);
      for (const t of invalid) {
        errors.push(
          `${label}: invalid template "${t}" in header "${headerKey}"`,
        );
      }
    }
  }

  // Check body (recursively collect strings)
  if (obj.body !== undefined) {
    const bodyStrings = collectStrings(obj.body);
    for (const s of bodyStrings) {
      const invalid = findInvalidTemplates(s);
      for (const t of invalid) {
        errors.push(`${label}: invalid template "${t}" in body`);
      }
    }
  }
}

/**
 * Validate an entire PipelineConfig, returning errors and warnings.
 */
export function validateConfig(config: PipelineConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Version check
  if (config.version !== "1" && config.version !== "2") {
    errors.push(`Invalid version "${config.version}" (expected "1" or "2")`);
  }

  // 2. Unique action IDs
  const ids = config.actions.map((s) => s.id);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  }
  if (duplicates.size > 0) {
    errors.push(`Duplicate action IDs: ${[...duplicates].join(", ")}`);
  }

  // 3 & 4. Per-action validation
  for (const action of config.actions) {
    const label = `Action "${action.id}"`;

    // Common required fields
    if (!action.id) {
      errors.push("An action is missing the 'id' field");
    }
    if (!action.type) {
      errors.push(`${label}: missing 'type' field`);
    }
    if (!action.target) {
      errors.push(`${label}: missing 'target' field`);
    }

    // Valid action type
    if (action.type && !VALID_ACTION_TYPES.has(action.type)) {
      errors.push(`${label}: invalid type "${action.type}"`);
    }

    // 6. Parseable conditions
    if (action.when !== undefined) {
      if (!isParseableExpression(action.when)) {
        errors.push(
          `${label}: 'when' expression has invalid syntax: "${action.when}"`,
        );
      }
    }

    // Type-specific validation
    if (action.type === "http") {
      const httpAction = action as HttpAction;
      if (!httpAction.method) {
        errors.push(`${label}: http action missing 'method'`);
      } else if (!KNOWN_HTTP_METHODS.has(httpAction.method.toUpperCase())) {
        warnings.push(
          `${label}: HTTP method "${httpAction.method}" is not a standard method (expected one of: ${[...KNOWN_HTTP_METHODS].join(", ")})`,
        );
      }
      if (!httpAction.url) {
        errors.push(`${label}: http action missing 'url'`);
      }
      if (!httpAction.extract) {
        errors.push(`${label}: http action missing 'extract'`);
      }

      // 5. Template validation
      validateTemplates(label, httpAction, errors);

      // 7. JSONPath validation
      if (httpAction.extract && !isValidJsonPath(httpAction.extract)) {
        errors.push(
          `${label}: invalid JSONPath in 'extract': "${httpAction.extract}"`,
        );
      }
    } else if (action.type === "waterfall") {
      const waterfallAction = action as WaterfallAction;
      if (
        !waterfallAction.providers ||
        !Array.isArray(waterfallAction.providers) ||
        waterfallAction.providers.length === 0
      ) {
        errors.push(
          `${label}: waterfall action must have a non-empty 'providers' array`,
        );
      } else {
        for (let i = 0; i < waterfallAction.providers.length; i++) {
          const provider = waterfallAction.providers[i]!;
          const pLabel = `${label} provider[${i}]`;
          if (!provider.name) {
            errors.push(`${pLabel}: missing 'name'`);
          }
          if (!provider.method) {
            errors.push(`${pLabel}: missing 'method'`);
          }
          if (!provider.url) {
            errors.push(`${pLabel}: missing 'url'`);
          }
          if (!provider.extract) {
            errors.push(`${pLabel}: missing 'extract'`);
          }

          // Template validation on each provider
          validateTemplates(
            provider.name ? `${label} provider "${provider.name}"` : pLabel,
            provider,
            errors,
          );

          // JSONPath validation on each provider
          if (provider.extract && !isValidJsonPath(provider.extract)) {
            errors.push(
              `${provider.name ? `${label} provider "${provider.name}"` : pLabel}: invalid JSONPath in 'extract': "${provider.extract}"`,
            );
          }
        }
      }
    } else if (action.type === "transform") {
      const transformAction = action as TransformAction;
      if (!transformAction.expression) {
        errors.push(`${label}: transform action missing 'expression'`);
      }
    } else if (action.type === "exec") {
      const execAction = action as ExecAction;
      if (!execAction.command) {
        errors.push(`${label}: exec action missing 'command'`);
      }

      // Template validation in command
      if (execAction.command) {
        const invalid = findInvalidTemplates(execAction.command);
        for (const t of invalid) {
          errors.push(
            `${label}: invalid template "${t}" in command — must be {{row.x}} or {{env.X}}`,
          );
        }
      }

      // Validate timeout if present
      if (
        execAction.timeout !== undefined &&
        (typeof execAction.timeout !== "number" || execAction.timeout <= 0)
      ) {
        errors.push(
          `${label}: exec action 'timeout' must be a positive number (got ${JSON.stringify(execAction.timeout)})`,
        );
      }

      // JSONPath validation on extract if present
      if (execAction.extract && !isValidJsonPath(execAction.extract)) {
        errors.push(
          `${label}: invalid JSONPath in 'extract': "${execAction.extract}"`,
        );
      }
    } else if (action.type === "lookup") {
      const lookupAction = action as LookupAction;
      if (!lookupAction.sourceTab) {
        errors.push(`${label}: lookup action missing 'sourceTab'`);
      }
      if (!lookupAction.matchColumn) {
        errors.push(`${label}: lookup action missing 'matchColumn'`);
      }
      if (!lookupAction.matchValue) {
        errors.push(`${label}: lookup action missing 'matchValue'`);
      }
      if (!lookupAction.returnColumn) {
        errors.push(`${label}: lookup action missing 'returnColumn'`);
      }
      if (
        lookupAction.matchOperator !== undefined &&
        lookupAction.matchOperator !== "equals" &&
        lookupAction.matchOperator !== "contains"
      ) {
        errors.push(
          `${label}: lookup action 'matchOperator' must be "equals" or "contains" (got "${lookupAction.matchOperator}")`,
        );
      }
      if (
        lookupAction.matchMode !== undefined &&
        lookupAction.matchMode !== "first" &&
        lookupAction.matchMode !== "all"
      ) {
        errors.push(
          `${label}: lookup action 'matchMode' must be "first" or "all" (got "${lookupAction.matchMode}")`,
        );
      }
      // Template validation in matchValue
      if (lookupAction.matchValue) {
        const invalid = findInvalidTemplates(lookupAction.matchValue);
        for (const t of invalid) {
          errors.push(
            `${label}: invalid template "${t}" in matchValue — must be {{row.x}} or {{env.X}}`,
          );
        }
      }
    } else if (action.type === "write") {
      const writeAction = action as WriteAction;
      if (!writeAction.destTab) {
        errors.push(`${label}: write action missing 'destTab'`);
      }
      if (
        !writeAction.columns ||
        typeof writeAction.columns !== "object" ||
        Object.keys(writeAction.columns).length === 0
      ) {
        errors.push(
          `${label}: write action must have a non-empty 'columns' object`,
        );
      } else {
        // Validate templates in column values (allow {{item.xxx}} for write actions)
        for (const [destCol, valueTemplate] of Object.entries(
          writeAction.columns,
        )) {
          if (!valueTemplate) {
            errors.push(
              `${label}: write action column "${destCol}" has empty value template`,
            );
          } else {
            const invalid = findInvalidTemplates(valueTemplate, true);
            for (const t of invalid) {
              errors.push(
                `${label}: invalid template "${t}" in column "${destCol}" — must be {{row.x}}, {{env.X}}, or {{item.x}}`,
              );
            }
          }
        }
      }
      if (
        writeAction.mode !== undefined &&
        writeAction.mode !== "append" &&
        writeAction.mode !== "upsert"
      ) {
        errors.push(
          `${label}: write action 'mode' must be "append" or "upsert" (got "${writeAction.mode}")`,
        );
      }
      if (writeAction.mode === "upsert") {
        if (!writeAction.upsertMatch?.column) {
          errors.push(`${label}: upsert mode requires 'upsertMatch.column'`);
        }
        if (!writeAction.upsertMatch?.value) {
          errors.push(`${label}: upsert mode requires 'upsertMatch.value'`);
        }
        // Validate template in upsertMatch.value
        if (writeAction.upsertMatch?.value) {
          const invalid = findInvalidTemplates(writeAction.upsertMatch.value);
          for (const t of invalid) {
            errors.push(
              `${label}: invalid template "${t}" in upsertMatch.value`,
            );
          }
        }
      }
      // Validate expand template if present
      if (writeAction.expand) {
        const invalid = findInvalidTemplates(writeAction.expand);
        for (const t of invalid) {
          errors.push(
            `${label}: invalid template "${t}" in expand — must be {{row.x}} or {{env.X}}`,
          );
        }
      }
      // Validate expandPath JSONPath if present
      if (writeAction.expandPath) {
        if (!writeAction.expand) {
          errors.push(`${label}: 'expandPath' requires 'expand' to be set`);
        }
        if (!isValidJsonPath(writeAction.expandPath)) {
          errors.push(
            `${label}: invalid JSONPath in 'expandPath': "${writeAction.expandPath}"`,
          );
        }
      }
    }
  }

  // 8. Source validation
  const sources: Source[] = config.sources ?? [];
  const sourceIds = new Set<string>();
  const VALID_SOURCE_TYPES = new Set(["http", "exec", "webhook"]);
  const VALID_SCHEDULES = new Set(["manual", "hourly", "daily", "weekly"]);

  for (const source of sources) {
    const label = `Source "${source.id}"`;

    if (!source.id) {
      errors.push("A source is missing the 'id' field");
    }
    if (sourceIds.has(source.id)) {
      errors.push(`Duplicate source ID: ${source.id}`);
    }
    sourceIds.add(source.id);

    if (!source.type || !VALID_SOURCE_TYPES.has(source.type)) {
      errors.push(
        `${label}: invalid type "${source.type}" (expected: http, exec, webhook)`,
      );
    }

    if (
      !source.columns ||
      typeof source.columns !== "object" ||
      Object.keys(source.columns).length === 0
    ) {
      errors.push(`${label}: must have a non-empty 'columns' object`);
    }

    if (source.type === "http") {
      const httpSource = source as HttpSource;
      if (!httpSource.method) {
        errors.push(`${label}: http source missing 'method'`);
      }
      if (!httpSource.url) {
        errors.push(`${label}: http source missing 'url'`);
      }
      if (!httpSource.extract) {
        errors.push(`${label}: http source missing 'extract'`);
      }
      if (httpSource.extract && !isValidJsonPath(httpSource.extract)) {
        errors.push(
          `${label}: invalid JSONPath in 'extract': "${httpSource.extract}"`,
        );
      }
      if (httpSource.extractPath && !isValidJsonPath(httpSource.extractPath)) {
        errors.push(
          `${label}: invalid JSONPath in 'extractPath': "${httpSource.extractPath}"`,
        );
      }
      // Validate templates in url
      if (httpSource.url) {
        const invalid = findInvalidTemplates(httpSource.url);
        for (const t of invalid) {
          errors.push(`${label}: invalid template "${t}" in url`);
        }
      }
    } else if (source.type === "exec") {
      const execSource = source as ExecSource;
      if (!execSource.command) {
        errors.push(`${label}: exec source missing 'command'`);
      }
      if (execSource.extract && !isValidJsonPath(execSource.extract)) {
        errors.push(
          `${label}: invalid JSONPath in 'extract': "${execSource.extract}"`,
        );
      }
      if (
        execSource.timeout !== undefined &&
        (typeof execSource.timeout !== "number" || execSource.timeout <= 0)
      ) {
        errors.push(
          `${label}: 'timeout' must be a positive number (got ${JSON.stringify(execSource.timeout)})`,
        );
      }
    }

    // Validate schedule if present (for non-webhook sources)
    if (source.type !== "webhook") {
      const s = source as HttpSource | ExecSource;
      if (
        s.schedule &&
        !VALID_SCHEDULES.has(s.schedule) &&
        !/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(s.schedule)
      ) {
        warnings.push(
          `${label}: schedule "${s.schedule}" is not a known schedule (known: manual, hourly, daily, weekly, or cron expression)`,
        );
      }
    }
  }

  // 9. Config size warning
  const serialized = JSON.stringify(config);
  if (serialized.length > CONFIG_SIZE_WARN) {
    warnings.push(
      `Config size is ${serialized.length} bytes — approaching the 30K Developer Metadata limit`,
    );
  }

  // 9. Settings validation
  if (config.settings) {
    const { concurrency, rateLimit, retryAttempts, retryBackoff } =
      config.settings;
    if (typeof concurrency !== "number" || concurrency <= 0) {
      errors.push(
        `settings.concurrency must be > 0 (got ${JSON.stringify(concurrency)})`,
      );
    }
    if (typeof rateLimit !== "number" || rateLimit < 0) {
      errors.push(
        `settings.rateLimit must be >= 0 (got ${JSON.stringify(rateLimit)})`,
      );
    }
    if (typeof retryAttempts !== "number" || retryAttempts < 0) {
      errors.push(
        `settings.retryAttempts must be >= 0 (got ${JSON.stringify(retryAttempts)})`,
      );
    }
    if (typeof retryBackoff === "string" && !KNOWN_BACKOFF.has(retryBackoff)) {
      warnings.push(
        `settings.retryBackoff "${retryBackoff}" is not a known strategy (known: ${[...KNOWN_BACKOFF].join(", ")})`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
