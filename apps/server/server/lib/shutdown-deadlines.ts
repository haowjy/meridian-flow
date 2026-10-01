/** Nested shutdown bounds derived from the process's single exit deadline. */
export const PROCESS_SHUTDOWN_DEADLINE_MS = 12_000;
export const APP_DRAIN_DEADLINE_MS = PROCESS_SHUTDOWN_DEADLINE_MS - 2_000;
// Leave the polling-loop stage time to record an orderly scheduler stop.
export const RECOVERY_LANE_STOP_DEADLINE_MS = 2_500;
