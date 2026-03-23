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
export function forceText(val) {
    if (/^[+=]/.test(val) || /^-\d/.test(val))
        return `'${val}`;
    return val;
}
/**
 * Flatten an object/value into a string-keyed record.
 * Scalar values are stored under the key "_value".
 * Object properties are stored directly as string entries.
 * Nested objects are JSON-stringified.
 */
export function flattenItem(item) {
    if (item === null || item === undefined) {
        return { _value: "" };
    }
    if (typeof item !== "object") {
        return { _value: String(item) };
    }
    const result = {};
    for (const [key, val] of Object.entries(item)) {
        if (val === null || val === undefined) {
            result[key] = "";
        }
        else if (typeof val === "object") {
            result[key] = JSON.stringify(val);
        }
        else {
            result[key] = String(val);
        }
    }
    return result;
}
