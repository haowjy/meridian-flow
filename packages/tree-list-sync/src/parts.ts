/**
 * Splits a Yjs update, or a Hocuspocus sync frame that carries one, into parts that each
 * apply on their own once the parts before them have. It is the list's way of sending a long
 * history in pieces of a few hundred records, so no honest sender meets a receiver's limit on
 * one update.
 *
 * Only an update of plain array items (no deletions, no types, no maps) is split; any other
 * update comes back whole. A part holds whole runs of one client's items cut at a clock, so a
 * single merged run of thousands of records is cut too.
 */

import { MAX_RECORDS } from "@meridian/project-tree";
import { createDecoder, readVarString, readVarUint, readVarUint8Array } from "lib0/decoding";
import {
  createEncoder,
  toUint8Array,
  writeVarString,
  writeVarUint,
  writeVarUint8Array,
} from "lib0/encoding";
import * as Y from "yjs";

type Run = { item: Y.Item; client: number; clock: number; length: number; content: unknown[] };

/** What one part holds at most: an eighth of what one admission accepts. */
export const PART_RECORDS = Math.floor(MAX_RECORDS / 8);

/** The Hocuspocus message type of a sync frame and its reply, and y-protocols' inner types. */
const OUTER_SYNC = 0;
const OUTER_SYNC_REPLY = 4;
const INNER_STEP2 = 1;
const INNER_UPDATE = 2;

/** Smaller frames are never split, so a live keystroke's update is not decoded on the way out. */
const MIN_BYTES_TO_SPLIT = 16 * 1024;

const dependsOn = (id: Y.ID | null, start: Map<number, number>, cursor: Map<number, number>) =>
  id === null ||
  id.clock < (start.get(id.client) ?? Number.POSITIVE_INFINITY) ||
  id.clock < (cursor.get(id.client) ?? 0);

/** The update as parts of at most `maxItems` array items, or `[update]` when it cannot be split. */
export function splitUpdate(update: Uint8Array, maxItems: number): Uint8Array[] {
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    return [update];
  }
  if (decoded.ds.clients.size > 0) return [update];
  const runs = new Map<number, Run[]>();
  let total = 0;
  for (const struct of decoded.structs) {
    if (!(struct instanceof Y.Item) || !(struct.content instanceof Y.ContentAny)) return [update];
    const content = struct.content.getContent();
    const list = runs.get(struct.id.client) ?? [];
    const last = list[list.length - 1];
    if (last && last.clock + last.length !== struct.id.clock) return [update];
    list.push({
      item: struct,
      client: struct.id.client,
      clock: struct.id.clock,
      length: content.length,
      content,
    });
    runs.set(struct.id.client, list);
    total += content.length;
  }
  if (total <= maxItems) return [update];

  // What the receiver has of each client is below its first run; the rest is sent in order.
  const start = new Map([...runs].map(([client, list]) => [client, list[0]?.clock ?? 0]));
  const cursor = new Map(start);
  const parts: Uint8Array[] = [];
  let part = new Map<number, Run[]>();
  let room = maxItems;
  const flush = () => {
    if (part.size === 0) return;
    parts.push(encodePart(part));
    part = new Map();
    room = maxItems;
  };
  let remaining = total;
  while (remaining > 0) {
    let progressed = false;
    for (const [client, list] of runs) {
      while (list.length > 0) {
        const run = list[0] as Run;
        const from = cursor.get(client) ?? run.clock;
        const offset = from - run.clock;
        // The first item of a run waits for its neighbours; a cut run follows its own first half.
        const ready =
          offset > 0 ||
          (dependsOn(run.item.origin, start, cursor) &&
            dependsOn(run.item.rightOrigin, start, cursor));
        if (!ready) break;
        const take = Math.min(room, run.length - offset);
        const taken = part.get(client) ?? [];
        taken.push({
          ...run,
          clock: from,
          length: take,
          content: run.content.slice(offset, offset + take),
        });
        part.set(client, taken);
        cursor.set(client, from + take);
        room -= take;
        remaining -= take;
        progressed = true;
        if (offset + take === run.length) list.shift();
        if (room === 0) flush();
      }
    }
    if (!progressed) return [update];
  }
  flush();
  return parts;
}

function encodePart(part: Map<number, Run[]>): Uint8Array {
  const encoder = new Y.UpdateEncoderV1();
  writeVarUint(encoder.restEncoder, part.size);
  for (const [client, list] of part) {
    writeVarUint(encoder.restEncoder, list.length);
    encoder.writeClient(client);
    writeVarUint(encoder.restEncoder, list[0]?.clock ?? 0);
    for (const run of list) {
      const { item } = run;
      const cut = run.clock > item.id.clock;
      new Y.Item(
        Y.createID(client, run.clock),
        null,
        cut ? Y.createID(client, run.clock - 1) : item.origin,
        null,
        item.rightOrigin,
        item.parent,
        item.parentSub,
        new Y.ContentAny(run.content),
      ).write(encoder, 0);
    }
  }
  // No deletions: the delete set is empty.
  writeVarUint(encoder.restEncoder, 0);
  return encoder.toUint8Array();
}

/**
 * A Hocuspocus frame as the frames to send in its place: a big sync update (or SyncStep2) goes
 * as updates in parts, the last one in the original's shape so the receiver's own bookkeeping
 * for that shape still happens once. Any other frame comes back unchanged.
 */
export function splitSyncFrame(frame: Uint8Array, maxItems: number): Uint8Array[] {
  if (frame.byteLength < MIN_BYTES_TO_SPLIT) return [frame];
  let name: string;
  let outer: number;
  let inner: number;
  let payload: Uint8Array;
  try {
    const decoder = createDecoder(frame);
    name = readVarString(decoder);
    outer = readVarUint(decoder);
    if (outer !== OUTER_SYNC && outer !== OUTER_SYNC_REPLY) return [frame];
    inner = readVarUint(decoder);
    if (inner !== INNER_STEP2 && inner !== INNER_UPDATE) return [frame];
    payload = readVarUint8Array(decoder);
  } catch {
    return [frame];
  }
  const parts = splitUpdate(payload, maxItems);
  if (parts.length === 1) return [frame];
  return parts.map((part, at) => {
    const encoder = createEncoder();
    writeVarString(encoder, name);
    writeVarUint(encoder, outer);
    writeVarUint(encoder, at === parts.length - 1 ? inner : INNER_UPDATE);
    writeVarUint8Array(encoder, part);
    return toUint8Array(encoder);
  });
}
