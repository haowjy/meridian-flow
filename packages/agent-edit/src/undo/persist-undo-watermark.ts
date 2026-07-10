/** Shared persist-time undo watermark predicates. */

export type PersistUndoWatermarkRecord = {
  persistGuardWatermark?: number;
};

export type PersistUndoWatermarkUpdate = {
  seq: number;
  origin: string | null | undefined;
};

export function persistUndoPlanWatermark(records: readonly PersistUndoWatermarkRecord[]): number {
  return records.reduce((max, record) => Math.max(max, record.persistGuardWatermark ?? 0), 0);
}

export function isLaterNonSystemUpdateAfterWatermark(
  update: PersistUndoWatermarkUpdate,
  watermark: number,
): boolean {
  return update.seq > watermark && update.origin !== "system";
}

export function hasLaterNonSystemUpdateAfterWatermark(
  updates: readonly PersistUndoWatermarkUpdate[],
  watermark: number,
): boolean {
  return updates.some((update) => isLaterNonSystemUpdateAfterWatermark(update, watermark));
}
