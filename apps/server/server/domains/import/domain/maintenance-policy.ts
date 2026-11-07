/** One database-time policy for candidate discovery and locked sweep decisions. */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const IMPORT_MAINTENANCE = {
  expiryMs: 7 * DAY,
  retentionMs: 30 * DAY,
  activityWindowMs: DAY,
  resweepDelayMs: 2 * HOUR,
  finalSweepDelayMs: DAY,
  orphanAgeMs: 2 * HOUR,
  batch: 500,
} as const;

export function maintenanceCutoffs(now: Date) {
  const before = (duration: number) => new Date(now.getTime() - duration);
  return {
    expiryBefore: before(IMPORT_MAINTENANCE.expiryMs),
    retentionBefore: before(IMPORT_MAINTENANCE.retentionMs),
    activeSince: before(IMPORT_MAINTENANCE.activityWindowMs),
    resweepBefore: before(IMPORT_MAINTENANCE.resweepDelayMs),
    finalSweepBefore: before(IMPORT_MAINTENANCE.finalSweepDelayMs),
    orphanBefore: before(IMPORT_MAINTENANCE.orphanAgeMs),
    resweepDelayMs: IMPORT_MAINTENANCE.resweepDelayMs,
  };
}
export type ImportMaintenanceCutoffs = ReturnType<typeof maintenanceCutoffs>;
