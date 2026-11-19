/**
 * What each AI edit's changes are in a draft now, read from the edit's recorded delta against the
 * draft's text and its review base: whether a change still stands, and which pending changes of
 * Changes it sits in. No Yjs item id is followed. The memos live for the process and are keyed on the
 * blocks a read looked at, so a re-read after a write elsewhere in the draft recomputes only the
 * changes whose blocks it touched (`agent-edit/content-merge/stands.ts`).
 */
import {
  type ChangeMemo,
  type ChangeRead,
  changeState,
  type EditChange,
  editChanges,
  type Reading,
  readChange,
  readDelta,
  readDraft,
  type StoredDelta,
  takeOut,
} from "@meridian/agent-edit/content-merge";
import { REVIEW_BASE_FRAGMENT, readBlocks } from "@meridian/agent-edit/diff";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import type * as Y from "yjs";

/** The one schema a draft's blocks are read and written with: nodes of another instance don't compare. */
export const draftSchema = buildDocumentSchema();
const schema = draftSchema;

/** The most changes the process keeps cuts and memos for; the oldest go first. */
const KEPT = 4000;

/** A bounded map that drops its oldest entry first. */
function bounded<V>() {
  const map = new Map<string, V>();
  return {
    get: (key: string) => map.get(key),
    set(key: string, value: V) {
      map.delete(key);
      map.set(key, value);
      if (map.size > KEPT) map.delete(map.keys().next().value as string);
    },
  };
}

/** The changes a recorded delta holds. The delta never changes, so its cut is made once. */
const cuts = bounded<EditChange[]>();
const memos = bounded<ChangeMemo>();

export interface DraftPartChanges {
  /** One read per change of the part, in the order its delta cuts them. */
  changes: ChangeRead[];
}

/** A part's changes carry what the card needs: a change is pending while it sits in a change of Changes. */
export const isPending = (change: ChangeRead) => change.sitsIn.size > 0;

export interface DraftChangeReading {
  reading: Reading;
  parts: Map<number, DraftPartChanges>;
}

/** Reads every given part of a draft against the draft as it stands. A part with no delta reads as having no changes. */
export function readDraftChanges(
  draft: Y.Doc,
  parts: readonly { id: number; delta: StoredDelta | null }[],
): DraftChangeReading {
  const reading = readDraft(
    schema,
    readBlocks(draft.getXmlFragment(REVIEW_BASE_FRAGMENT), schema),
    readBlocks(draft.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema),
  );
  const out = new Map<number, DraftPartChanges>();
  for (const part of parts) {
    if (!part.delta) {
      out.set(part.id, { changes: [] });
      continue;
    }
    let cut = cuts.get(String(part.id));
    if (!cut) {
      cut = editChanges(schema, readDelta(schema, part.delta));
      cuts.set(String(part.id), cut);
    }
    out.set(part.id, {
      changes: cut.map((change, index) => {
        const key = `${part.id}:${index}`;
        const read = readChange(reading, change, memos.get(key));
        memos.set(key, read.memo);
        return read;
      }),
    });
  }
  return { reading, parts: out };
}

/**
 * `text` with every change of `parts` that still stands taken out, in the order given, and the
 * parts that had one. The one rule a draft Undo applies, to the committed text under the draft's
 * hold and, as the model's plan, to a copy of it.
 */
export function takeOutStanding<P extends { delta: StoredDelta | null }>(
  text: readonly PMNode[],
  parts: readonly P[],
): { text: readonly PMNode[]; taken: P[] } {
  let blocks = text;
  const taken: P[] = [];
  for (const part of parts) {
    if (!part.delta) continue;
    for (const change of editChanges(schema, readDelta(schema, part.delta)))
      if (changeState(schema, change, blocks) === "stands") {
        blocks = takeOut(schema, change, blocks);
        if (!taken.includes(part)) taken.push(part);
      }
  }
  return { text: blocks, taken };
}
