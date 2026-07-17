/** Summarizes Yjs updates into stable correlation and size metadata. */

import { digest } from "lib0/hash/sha256";
import * as Y from "yjs";
import type { Span, UpdateSummary } from "./types.js";

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function summarizeUpdate(update: Uint8Array): UpdateSummary {
  const decoded = Y.decodeUpdate(update);
  const structs = decoded.structs
    .filter((struct) => !(struct instanceof Y.Skip))
    .sort((left, right) => left.id.client - right.id.client || left.id.clock - right.id.clock);
  const structSpans: Span[] = [];

  for (const struct of structs) {
    const previous = structSpans.at(-1);
    const clockTo = struct.id.clock + struct.length;
    if (previous?.client === struct.id.client && previous.clockTo === struct.id.clock) {
      previous.clockTo = clockTo;
    } else {
      structSpans.push({
        client: struct.id.client,
        clockFrom: struct.id.clock,
        clockTo,
      });
    }
  }
  structSpans.sort(compareSpans);

  const deleteSpans = Array.from(decoded.ds.clients, ([client, ranges]) =>
    ranges.map(({ clock, len }) => ({ client, clockFrom: clock, clockTo: clock + len })),
  )
    .flat()
    .sort(compareSpans);
  const deletedLength = deleteSpans.reduce(
    (total, span) => total + span.clockTo - span.clockFrom,
    0,
  );
  const spansKey = [...structSpans.map(spanToken("s")), ...deleteSpans.map(spanToken("d"))].join(
    ",",
  );

  return {
    structSpans,
    deleteSpans,
    spansKey,
    structCount: structs.length,
    deleteRangeCount: deleteSpans.length,
    deletedLength,
    isNoop: structs.length === 0 && deleteSpans.length === 0,
    bytes: update.byteLength,
    updateHash: toHex(digest(update)).slice(0, 16),
  };
}

function compareSpans(left: Span, right: Span): number {
  return left.client - right.client || left.clockFrom - right.clockFrom;
}

function spanToken(kind: "s" | "d"): (span: Span) => string {
  return ({ client, clockFrom, clockTo }) => `${kind}:${client}:${clockFrom}-${clockTo}`;
}
