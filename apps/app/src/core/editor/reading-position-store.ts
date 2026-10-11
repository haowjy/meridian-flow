/** Account-stamped device memory of document-relative places, bounded by LRU. */

import * as Y from "yjs";
import { browserRecord, isRecord, type StorageSource } from "@/client/storage/browser-record";

export const READING_POSITION_STORAGE_KEY = "meridian:reading-position:v1";
export const READING_POSITION_LIMIT = 300;
export type ReadingAnchor = number[];
export type ReadingPosition = {
  viewport: { block: ReadingAnchor; text: ReadingAnchor | null; offset: number };
  selection: { anchor: ReadingAnchor; head: ReadingAnchor; node: boolean };
};
type Entry = { documentId: string; place: ReadingPosition; updatedAt: number; accessedAt: number };

function validAnchor(value: unknown): value is ReadingAnchor {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 256 ||
    !value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  )
    return false;
  try {
    Y.decodeRelativePosition(Uint8Array.from(value));
    return true;
  } catch {
    return false;
  }
}
function validPlace(value: unknown): value is ReadingPosition {
  if (!isRecord(value)) return false;
  const { viewport, selection } = value;
  return Boolean(
    isRecord(viewport) &&
      isRecord(selection) &&
      validAnchor(viewport.block) &&
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
    typeof value.documentId === "string" &&
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
          new Set(value.map((entry) => entry.documentId)).size !== value.length
        )
          return undefined;
        return value;
      },
    );
  }
  load(documentId: string): ReadingPosition | null {
    const entries = this.record.read() ?? [];
    const entry = entries.find((entry) => entry.documentId === documentId);
    if (!entry) return null;
    entry.accessedAt = Date.now();
    this.record.write(entries);
    return entry.place;
  }
  save(documentId: string, place: ReadingPosition, updatedAt: number): void {
    let entries = this.record.read() ?? [];
    const previous = entries.find((entry) => entry.documentId === documentId);
    // A background view flushing an earlier gesture must not overwrite the last active view.
    if (previous && previous.updatedAt > updatedAt) return;
    entries = entries.filter((entry) => entry.documentId !== documentId);
    entries.push({ documentId, place, updatedAt, accessedAt: updatedAt });
    entries.sort((a, b) => b.accessedAt - a.accessedAt);
    entries.length = Math.min(entries.length, READING_POSITION_LIMIT);
    this.record.write(entries);
  }
}
