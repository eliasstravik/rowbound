/**
 * Escape a string for safe use in shell commands.
 *
 * Wraps the value in single quotes and escapes any embedded single quotes.
 * This prevents shell injection via metacharacters like $(), backticks, ;, |, etc.
 */
export declare function shellEscape(value: string): string;
