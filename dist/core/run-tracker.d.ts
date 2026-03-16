import type { RunPipelineOptions } from "./engine.js";
import type { RunState } from "./run-state.js";
/**
 * Create callback hooks that track run state and write to disk.
 *
 * The returned callbacks should be composed with any user-provided callbacks,
 * not replace them.
 */
export declare function createRunTracker(state: RunState): {
    onRowStart: NonNullable<RunPipelineOptions["onRowStart"]>;
    onActionComplete: NonNullable<RunPipelineOptions["onActionComplete"]>;
    onError: NonNullable<RunPipelineOptions["onError"]>;
    onRowComplete: NonNullable<RunPipelineOptions["onRowComplete"]>;
    finalize: (aborted: boolean) => Promise<void>;
};
