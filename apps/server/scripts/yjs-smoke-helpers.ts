import { YJS_WS_MESSAGE_SYNC } from "@meridian/contracts/protocol";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { markdownFromState } from "../server/domains/collab/domain/yjs-mirror.js";

export function applyWsSyncPayloadToMarkdown(doc: Y.Doc, payload: Uint8Array): string {
  const decoder = decoding.createDecoder(payload);
  const envelopeType = decoding.readVarUint(decoder);
  if (envelopeType !== YJS_WS_MESSAGE_SYNC) {
    throw new Error(`expected Yjs sync envelope, got ${envelopeType}`);
  }
  const encoder = encoding.createEncoder();
  syncProtocol.readSyncMessage(decoder, encoder, doc, null, (error) => {
    throw error;
  });
  return markdownFromState("document", Y.encodeStateAsUpdate(doc));
}
