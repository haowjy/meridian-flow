/**
 * Whether a copy holds words the server lacks: what decides the one "Couldn't save" pill when
 * typing has nowhere to go (a read admission, a room ended below the history cutoff, a copy
 * deleted on a final fact). A change with no words (a deletion, a format change, a structure
 * edit) is dropped silently.
 */
import {
  type DocVersion,
  decodeEnvelope,
  decodeRoomVersion,
  freshPeerId,
  RoomDocs,
  type RoomVersion,
  STRUCTURE_KEY,
  withVector,
} from "@meridian/document-model";
import type { LoroDoc } from "loro-crdt";
import { type LoadedCopy, SERVER_META } from "./local-copy-store";
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

/**
 * Whether a stored copy holds words beyond `server`, or, without it, beyond the copy's own record
 * of what the server holds. A copy with no record offers everything it holds. A copy that won't
 * load holds nothing anyone can read.
 */
export function storedWordsBeyond(loaded: LoadedCopy, server?: RoomVersion): boolean {
  const docs = RoomDocs.create(documentShape(), freshPeerId());
  try {
    if (loaded.snapshots.size > 0) docs.importBatch(loaded.snapshots);
    for (const batch of loaded.updates) docs.importBatch(decodeEnvelope(batch));
    const mark = loaded.meta.get(SERVER_META);
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
