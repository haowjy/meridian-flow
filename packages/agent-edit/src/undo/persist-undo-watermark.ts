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

export function isLaterWriterUpdateAfterWatermark(
  update: PersistUndoWatermarkUpdate,
  watermark: number,
): boolean {
  return update.seq > watermark && update.origin?.startsWith("human:") === true;
}

export function hasLaterWriterUpdateAfterWatermark(
  updates: readonly PersistUndoWatermarkUpdate[],
  watermark: number,
): boolean {
  return updates.some((update) => isLaterWriterUpdateAfterWatermark(update, watermark));
}
