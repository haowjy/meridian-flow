import { browserRecord, isRecord, type StorageSource } from "@/client/storage/browser-record";
import { decodePoint, type EncodedPoint } from "./loro-points";

export const READING_POSITION_STORAGE_KEY = "meridian:reading-position:v2";
export const READING_POSITION_LIMIT = 300;
export type ReadingAnchor = EncodedPoint;
export type ReadingPosition = {
  viewport: { block: string; text: ReadingAnchor | null; offset: number };
  selection: { anchor: ReadingAnchor; head: ReadingAnchor; node: boolean };
};
type Entry = { roomKey: string; place: ReadingPosition; updatedAt: number; accessedAt: number };

function validAnchor(value: unknown): value is ReadingAnchor {
  return decodePoint(value) !== null;
}
function validPlace(value: unknown): value is ReadingPosition {
  if (!isRecord(value)) return false;
  const { viewport, selection } = value;
  return Boolean(
    isRecord(viewport) &&
      isRecord(selection) &&
      typeof viewport.block === "string" &&
      (viewport.text === null || validAnchor(viewport.text)) &&
      typeof viewport.offset === "number" &&
      viewport.offset >= 0 &&
      viewport.offset <= 1 &&
      validAnchor(selection.anchor) &&
      validAnchor(selection.head) &&
      typeof selection.node === "boolean",
  );
}

function validEntry(value: unknown): value is Entry {
  return (
    isRecord(value) &&
    typeof value.roomKey === "string" &&
    validPlace(value.place) &&
    [value.updatedAt, value.accessedAt].every(
      (time) => typeof time === "number" && Number.isFinite(time),
    )
  );
}

export class ReadingPositionStore {
  private readonly record: ReturnType<typeof browserRecord<Entry[]>>;
  constructor(accountId: string, storage: StorageSource = "local") {
    this.record = browserRecord<Entry[]>(
      storage,
      {
        key: `${READING_POSITION_STORAGE_KEY}:${encodeURIComponent(accountId)}`,
        version: 1,
        accountId,
      },
      (value) => {
        if (
          !Array.isArray(value) ||
          value.length > READING_POSITION_LIMIT ||
          !value.every(validEntry) ||
          new Set(value.map((entry) => entry.roomKey)).size !== value.length
        )
          return undefined;
        return value;
      },
    );
  }
  load(roomKey: string): ReadingPosition | null {
    const entries = this.record.read() ?? [];
    const entry = entries.find((entry) => entry.roomKey === roomKey);
    if (!entry) return null;
    entry.accessedAt = Date.now();
    this.record.write(entries);
    return entry.place;
  }
  save(roomKey: string, place: ReadingPosition, updatedAt: number): void {
    let entries = this.record.read() ?? [];
    const previous = entries.find((entry) => entry.roomKey === roomKey);
    // A background view flushing an earlier gesture must not overwrite the last active view.
    if (previous && previous.updatedAt > updatedAt) return;
    entries = entries.filter((entry) => entry.roomKey !== roomKey);
    entries.push({ roomKey, place, updatedAt, accessedAt: updatedAt });
    entries.sort((a, b) => b.accessedAt - a.accessedAt);
    entries.length = Math.min(entries.length, READING_POSITION_LIMIT);
    this.record.write(entries);
  }
}
