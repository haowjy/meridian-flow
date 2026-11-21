import * as Y from "yjs";
import { createDocumentContainment } from "./document-containment.js";

export class WriterFrameGapError extends Error {
  constructor(client: number, from: number, held: number) {
    super(`writer-frame-gap: client ${client} starts at clock ${from}, the room holds ${held}`);
    this.name = "WriterFrameGapError";
  }
}

const roomContainment = createDocumentContainment();

/**
 * What of a writer's frame the room lacks, or null when it holds all of it (a reconnect's
 * replay). Throws on a frame that starts past the room's clock for one of its clients: no later
 * read could integrate it, so the socket closes and the reconnect's handshake carries the prefix.
 */
export function novelToRoom(room: Y.Doc, update: Uint8Array): Uint8Array | null {
  if (roomContainment.contains(room, update)) return null;
  const stateVector = Y.encodeStateVector(room);
  const clocks = Y.decodeStateVector(stateVector);
  let overlaps = false;
  for (const [client, from] of Y.parseUpdateMeta(update).from) {
    const held = clocks.get(client) ?? 0;
    if (from > held) throw new WriterFrameGapError(client, from, held);
    if (from < held) overlaps = true;
  }
  return overlaps ? Y.diffUpdate(update, stateVector) : update;
}
