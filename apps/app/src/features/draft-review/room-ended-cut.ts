/**
 * A frozen click rebuilt on the draft as the server holds it, for a room that ended holding typing
 * it never delivered. The clicked snapshot names that typing, which the server will never get, so
 * the click is cut again at the snapshot without it: a chosen change whose id is there is kept, a
 * change the typing touched is taken as the server holds it (the groups at its base tokens), and a
 * change made only of that typing stays. The typing itself comes back through the hand-back.
 */
import {
  applySpanPatches,
  baseViewDelta,
  composeGroups,
  diffBlocks,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  type ReviewGroup,
  readBlocks,
} from "@meridian/agent-edit/diff";
import type { ApplyClick } from "@meridian/contracts/branches";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import * as Y from "yjs";

type Range = { clock: number; len: number };

/** `ranges` without `taken`, both sorted and disjoint. */
function subtract(ranges: readonly Range[], taken: readonly Range[]): Range[] {
  const out: Range[] = [];
  for (const range of ranges) {
    let at = range.clock;
    const end = range.clock + range.len;
    for (const cut of taken) {
      const cutEnd = cut.clock + cut.len;
      if (cutEnd <= at || cut.clock >= end) continue;
      if (cut.clock > at) out.push({ clock: at, len: cut.clock - at });
      at = Math.max(at, cutEnd);
    }
    if (at < end) out.push({ clock: at, len: end - at });
  }
  return out;
}

/** The clicked snapshot without the undelivered update's items and deletions. */
function withoutUndelivered(clicked: Y.Snapshot, undelivered: Uint8Array): Y.Snapshot {
  const { from } = Y.parseUpdateMeta(undelivered);
  const { ds } = Y.decodeUpdate(undelivered);
  const sv = new Map(clicked.sv);
  for (const [client, clock] of from) if ((sv.get(client) ?? 0) > clock) sv.set(client, clock);
  const kept = Y.createDeleteSet();
  for (const [client, ranges] of clicked.ds.clients) {
    const below = sv.get(client) ?? 0;
    const left = subtract(ranges, ds.clients.get(client) ?? [])
      .filter((range) => range.clock < below)
      .map((range) => ({ clock: range.clock, len: Math.min(range.len, below - range.clock) }));
    if (left.length) kept.clients.set(client, left as typeof ranges);
  }
  return Y.createSnapshot(kept, sv);
}

const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }) =>
  Math.max(a.from, b.from) <= Math.min(a.to, b.to);

export type RoomEndedCut = {
  body: ApplyClick;
  patched: readonly PMNode[];
  /** Chosen changes with nothing of them on the server: they stay in the draft. */
  stayed: string[];
};

/**
 * `body` cut again on `document` without `undelivered`. Null when the snapshot can't be rebuilt:
 * the text an undelivered deletion removed was already collected, so every chosen change stays.
 */
export function cutWithoutUndelivered(input: {
  document: Y.Doc;
  undelivered: Uint8Array;
  body: ApplyClick & { snapshot: string };
  optimistic: readonly PMNode[];
  chosen: readonly ReviewGroup[];
  schema: Schema;
}): RoomEndedCut | null {
  const clicked = Y.decodeSnapshotV2(
    Uint8Array.from(atob(input.body.snapshot), (c) => c.charCodeAt(0)),
  );
  const held = withoutUndelivered(clicked, input.undelivered);
  const copy = new Y.Doc({ gc: false });
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(input.document));
  let restorable = true;
  copy.transact((transaction) =>
    Y.iterateDeletedStructs(transaction, Y.decodeUpdate(input.undelivered).ds, (struct) => {
      if (
        struct instanceof Y.GC ||
        (struct instanceof Y.Item && struct.content instanceof Y.ContentDeleted)
      )
        restorable = false;
    }),
  );
  if (!restorable) {
    copy.destroy();
    return null;
  }
  const cut = Y.createDocFromSnapshot(copy, held, new Y.Doc({ gc: false }));
  copy.destroy();
  try {
    const { schema, optimistic } = input;
    const projection = projectReview(
      diffBlocks(optimistic, readBlocks(cut.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema)),
    );
    const ids = new Set<string>();
    const stayed: string[] = [];
    for (const group of input.chosen) {
      const same = projection.groups.find((candidate) => candidate.id === group.id);
      const taken = same
        ? [same]
        : projection.groups.filter((candidate) =>
            candidate.hunks.some((hunk) =>
              group.hunks.some((chosen) => overlaps(hunk.baseTokens, chosen.baseTokens)),
            ),
          );
      if (!taken.length) stayed.push(group.id);
      for (const one of taken) ids.add(one.id);
    }
    const groupIds = projection.groups.map((group) => group.id).filter((id) => ids.has(id));
    return {
      body: {
        ...input.body,
        snapshot: btoa(
          Array.from(Y.encodeSnapshotV2(held), (byte) => String.fromCharCode(byte)).join(""),
        ),
        groupIds,
        baseViewDelta: baseViewDelta(
          schema,
          readBlocks(cut.getXmlFragment(REVIEW_BASE_FRAGMENT), schema),
          optimistic,
        ).map((patch) => ({ ...patch, blocks: patch.blocks.map((block) => block.toJSON()) })),
      },
      patched: applySpanPatches(
        optimistic,
        composeGroups(schema, projection, groupIds, "apply"),
        "base",
      ),
      stayed,
    };
  } finally {
    cut.destroy();
  }
}
