/**
 * Extract a value from data using a JSONPath expression.
 *
 * - Applies the JSONPath expression to the input data
 * - Arrays: takes the first element
 * - Objects: JSON.stringify
 * - Coerces the final result to string
 * - Returns empty string if no match
 */
export declare function extractValue(data: unknown, expression: string): string;
