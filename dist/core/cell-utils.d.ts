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
export declare function forceText(val: string): string;
/**
 * Flatten an object/value into a string-keyed record.
 * Scalar values are stored under the key "_value".
 * Object properties are stored directly as string entries.
 * Nested objects are JSON-stringified.
 */
export declare function flattenItem(item: unknown): Record<string, string>;
