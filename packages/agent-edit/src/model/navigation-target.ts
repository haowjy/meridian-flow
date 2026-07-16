/** Browser-safe codec and strict live-document validation for trail navigation targets. */
import * as Y from "yjs";
import { type BlockItemId, getBlockItemId } from "./block-hash.js";
import { PROSEMIRROR_FRAGMENT_NAME } from "./prosemirror-fragment.js";

export type LiveBlockRangeTarget = {
  kind: "live_block_range";
  relStart: string;
  relEnd: string;
  targetBlockId: BlockItemId;
};

export function isBlockItemId(value: unknown): value is BlockItemId {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BlockItemId>;
  return (
    Number.isSafeInteger(candidate.clientID) &&
    (candidate.clientID ?? -1) >= 0 &&
    Number.isSafeInteger(candidate.clock) &&
    (candidate.clock ?? -1) >= 0
  );
}

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
    if (!(block instanceof Y.XmlElement) || !isBlockItemId(input.target.targetBlockId)) {
      return null;
    }
    const blockId = getBlockItemId(block);
    if (
      blockId.clientID !== input.target.targetBlockId.clientID ||
      blockId.clock !== input.target.targetBlockId.clock
    )
      return null;
    return { start, end, block };
  } catch {
    return null;
  }
}
