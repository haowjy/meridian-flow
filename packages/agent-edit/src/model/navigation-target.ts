/** Browser-safe codec and strict live-document validation for trail navigation targets. */
import * as Y from "yjs";
import { getBlockHash } from "./block-hash.js";
import { PROSEMIRROR_FRAGMENT_NAME } from "./prosemirror-fragment.js";

export type LiveBlockRangeTarget = {
  kind: "live_block_range";
  relStart: string;
  relEnd: string;
  targetBlockId: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeNavigationPosition(position: Y.RelativePosition): string {
  return bytesToBase64(Y.encodeRelativePosition(position));
}

export function decodeNavigationPosition(value: string): Y.RelativePosition {
  return Y.decodeRelativePosition(base64ToBytes(value));
}

export function validateLiveBlockRange(input: {
  doc: Y.Doc;
  target: LiveBlockRangeTarget;
  blockIdOf?: (block: Y.XmlElement) => string;
}): { start: Y.RelativePosition; end: Y.RelativePosition; block: Y.XmlElement } | null {
  try {
    const start = decodeNavigationPosition(input.target.relStart);
    const end = decodeNavigationPosition(input.target.relEnd);
    const absoluteStart = Y.createAbsolutePositionFromRelativePosition(start, input.doc);
    const absoluteEnd = Y.createAbsolutePositionFromRelativePosition(end, input.doc);
    const root = input.doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    if (
      !absoluteStart ||
      !absoluteEnd ||
      absoluteStart.type !== root ||
      absoluteEnd.type !== root ||
      absoluteEnd.index !== absoluteStart.index + 1
    ) {
      return null;
    }
    const block = root.get(absoluteStart.index);
    if (
      !(block instanceof Y.XmlElement) ||
      (input.blockIdOf ?? getBlockHash)(block) !== input.target.targetBlockId
    ) {
      return null;
    }
    return { start, end, block };
  } catch {
    return null;
  }
}
