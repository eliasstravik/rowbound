import { JSONPath } from "jsonpath-plus";
/**
 * Extract a value from data using a JSONPath expression.
 *
 * - Applies the JSONPath expression to the input data
 * - Arrays: takes the first element
 * - Objects: JSON.stringify
 * - Coerces the final result to string
 * - Returns empty string if no match
 */
export function extractValue(data, expression) {
    let result;
    try {
        result = JSONPath({ path: expression, json: data, eval: false });
    }
    catch {
        return "";
    }
    // JSONPath always returns an array of matches
    if (Array.isArray(result)) {
        if (result.length === 0) {
            return "";
        }
        result = result[0];
    }
    if (result === undefined || result === null) {
        return "";
    }
    if (typeof result === "object") {
        return JSON.stringify(result);
    }
    return String(result);
}
