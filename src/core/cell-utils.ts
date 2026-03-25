/**
 * Shared cell utilities for writing data to Google Sheets.
 * Used by both write actions and sources.
 */

/**
 * Force text mode for values that Google Sheets would misinterpret as
 * numbers or formulas (e.g. phone numbers like "+46 8 797 75 00").
 * A leading single quote tells Sheets to treat the value as plain text
 * without displaying the quote itself (only works with USER_ENTERED mode).
 */
export function forceText(val: string): string {
  if (/^[+=]/.test(val) || /^-\d/.test(val)) return `'${val}`;
  return val;
}

/**
 * Flatten an object/value into a string-keyed record.
 * Scalar values are stored under the key "_value".
 * Object properties are stored directly as string entries.
 * Nested objects are JSON-stringified.
 */
export function flattenItem(
  item: unknown,
  prefix = "",
): Record<string, string> {
  if (item === null || item === undefined) {
    return prefix ? { [prefix]: "" } : { _value: "" };
  }
  if (typeof item !== "object") {
    return prefix ? { [prefix]: String(item) } : { _value: String(item) };
  }
  if (Array.isArray(item)) {
    const result: Record<string, string> = {};
    result[prefix || "_value"] = JSON.stringify(item);
    for (let i = 0; i < item.length; i++) {
      const nested = flattenItem(item[i], `${prefix}[${i}]`);
      Object.assign(result, nested);
    }
    return result;
  }
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(item as Record<string, unknown>)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val === null || val === undefined) {
      result[fullKey] = "";
    } else if (typeof val === "object") {
      // Store JSON string at this level AND recurse for dot-path access
      result[fullKey] = JSON.stringify(val);
      Object.assign(result, flattenItem(val, fullKey));
    } else {
      result[fullKey] = String(val);
    }
  }
  return result;
}
