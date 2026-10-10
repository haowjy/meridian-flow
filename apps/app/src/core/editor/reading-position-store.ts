/** Account-stamped device memory of document-relative places, bounded by LRU. */
import * as Y from "yjs";

export const READING_POSITION_STORAGE_KEY = "meridian:reading-position:v1";
export const READING_POSITION_LIMIT = 300;
export type ReadingAnchor = number[];
export type ReadingPosition = {
  viewport: { block: ReadingAnchor; text: ReadingAnchor | null; offset: number };
  selection: { anchor: ReadingAnchor; head: ReadingAnchor; node: boolean };
};
type Entry = { documentId: string; place: ReadingPosition; updatedAt: number; accessedAt: number };
type Snapshot = { version: 1; accountId: string; entries: Entry[] };
type StoragePort = Pick<Storage, "getItem" | "setItem">;

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
  if (!value || typeof value !== "object") return false;
  const { viewport, selection } = value as ReadingPosition;
  return Boolean(
    viewport &&
      selection &&
      validAnchor(viewport.block) &&
      (viewport.text === null || validAnchor(viewport.text)) &&
      Number.isFinite(viewport.offset) &&
      viewport.offset >= 0 &&
      viewport.offset <= 1 &&
      validAnchor(selection.anchor) &&
      validAnchor(selection.head) &&
      typeof selection.node === "boolean",
  );
}

export class ReadingPositionStore {
  constructor(
    private readonly accountId: string,
    private readonly storage: () => StoragePort = () => localStorage,
  ) {}
  private get key() {
    return `${READING_POSITION_STORAGE_KEY}:${encodeURIComponent(this.accountId)}`;
  }
  private read(): Snapshot {
    const empty: Snapshot = { version: 1, accountId: this.accountId, entries: [] };
    try {
      const value = JSON.parse(this.storage().getItem(this.key) ?? "null") as Snapshot | null;
      if (
        value?.version !== 1 ||
        value.accountId !== this.accountId ||
        !Array.isArray(value.entries) ||
        value.entries.length > READING_POSITION_LIMIT ||
        !value.entries.every(
          (entry) =>
            entry &&
            typeof entry.documentId === "string" &&
            validPlace(entry.place) &&
            Number.isFinite(entry.updatedAt) &&
            Number.isFinite(entry.accessedAt),
        ) ||
        new Set(value.entries.map((entry) => entry.documentId)).size !== value.entries.length
      )
        return empty;
      return value;
    } catch {
      return empty;
    }
  }
  private write(snapshot: Snapshot) {
    try {
      this.storage().setItem(this.key, JSON.stringify(snapshot));
    } catch {
      /* Storage cannot block writing. */
    }
  }
  load(documentId: string): ReadingPosition | null {
    const snapshot = this.read();
    const entry = snapshot.entries.find((entry) => entry.documentId === documentId);
    if (!entry) return null;
    entry.accessedAt = Date.now();
    this.write(snapshot);
    return entry.place;
  }
  save(documentId: string, place: ReadingPosition, updatedAt: number): void {
    const snapshot = this.read();
    const previous = snapshot.entries.find((entry) => entry.documentId === documentId);
    // A background view flushing an earlier gesture must not overwrite the last active view.
    if (previous && previous.updatedAt > updatedAt) return;
    snapshot.entries = snapshot.entries.filter((entry) => entry.documentId !== documentId);
    snapshot.entries.push({ documentId, place, updatedAt, accessedAt: updatedAt });
    snapshot.entries.sort((a, b) => b.accessedAt - a.accessedAt);
    snapshot.entries.length = Math.min(snapshot.entries.length, READING_POSITION_LIMIT);
    this.write(snapshot);
  }
}
