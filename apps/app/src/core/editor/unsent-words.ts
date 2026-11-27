import {
  batchEnd,
  type DocKey,
  type DocVersion,
  decodeEnvelope,
  decodeRoomVersion,
  freshPeerId,
  mergeVersion,
  RoomDocs,
  type RoomVersion,
  STRUCTURE_KEY,
  updateEnd,
  versionCovers,
  withVector,
} from "@meridian/document-model";
import type { LoroDoc } from "loro-crdt";
import { type LoadedCopy, SAVED_META } from "./local-copy-store";
import { documentShape } from "./room-content";

type JsonOp = { content?: { type?: string; text?: unknown } };

function docHasWordsBeyond(doc: LoroDoc, since: DocVersion | undefined): boolean {
  const json = since
    ? withVector(since, (vector) => doc.exportJsonUpdates(vector))
    : doc.exportJsonUpdates();
  for (const change of json.changes)
    for (const op of change.ops as JsonOp[])
      if (
        op.content?.type === "insert" &&
        typeof op.content.text === "string" &&
        /\S/.test(op.content.text)
      )
        return true;
  return false;
}

export function wordsBeyond(docs: RoomDocs, server: RoomVersion): boolean {
  for (const [key, doc] of docs.owned())
    if (key !== STRUCTURE_KEY && docHasWordsBeyond(doc, server.get(key))) return true;
  return false;
}

export function storedOpsBeyondMark(loaded: LoadedCopy): boolean {
  const stored = new Map<DocKey, DocVersion>();
  try {
    for (const [key, bytes] of loaded.snapshots)
      mergeVersion(stored, new Map([[key, updateEnd(bytes)]]));
    for (const batch of loaded.updates) mergeVersion(stored, batchEnd(batch));
  } catch (error) {
    reportError(error);
    return true;
  }
  const mark = loaded.meta.get(SAVED_META);
  return !versionCovers(mark instanceof Uint8Array ? decodeRoomVersion(mark) : new Map(), stored);
}

export function storedWordsBeyond(loaded: LoadedCopy, server?: RoomVersion): boolean {
  const docs = RoomDocs.create(documentShape(), freshPeerId());
  try {
    if (loaded.snapshots.size > 0) docs.importBatch(loaded.snapshots);
    for (const batch of loaded.updates) docs.importBatch(decodeEnvelope(batch));
    const mark = loaded.meta.get(SAVED_META);
    return wordsBeyond(
      docs,
      server ?? (mark instanceof Uint8Array ? decodeRoomVersion(mark) : new Map()),
    );
  } catch (error) {
    reportError(error);
    return false;
  } finally {
    docs.free();
  }
}
