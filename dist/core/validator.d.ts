import type { PipelineConfig } from "./types.js";
/** Result of validating a PipelineConfig. */
export interface ValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}
/**
 * Validate an entire PipelineConfig, returning errors and warnings.
 */
export declare function validateConfig(config: PipelineConfig): ValidationResult;
