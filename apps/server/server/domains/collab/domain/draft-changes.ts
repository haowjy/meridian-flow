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
  changeStateIn,
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

/** A draft's review base and text as blocks. */
export function draftBlocks(draft: Y.Doc | undefined): { base: PMNode[]; text: PMNode[] } {
  return {
    base: draft ? readBlocks(draft.getXmlFragment(REVIEW_BASE_FRAGMENT), schema) : [],
    text: draft ? readBlocks(draft.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema) : [],
  };
}

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

/**
 * Reads every given part of a draft against the draft as it stands. A part with no delta reads as
 * having no changes. `taken`: an Undo took the part out of the text.
 */
export function readDraftChanges(
  draft: Y.Doc,
  parts: readonly { id: number; delta: StoredDelta | null; taken?: boolean }[],
): DraftChangeReading {
  const { base, text } = draftBlocks(draft);
  return readChangesAt(base, text, parts);
}

/** `readDraftChanges` over a base and text already read: an Apply reads the draft against the base its click saw. */
export function readChangesAt(
  base: readonly PMNode[],
  text: readonly PMNode[],
  parts: readonly { id: number; delta: StoredDelta | null; taken?: boolean }[],
): DraftChangeReading {
  const reading = readDraft(schema, base, text);
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
        const read = readChange(reading, change, memos.get(key), part.taken);
        memos.set(key, read.memo);
        return read;
      }),
    });
  }
  return { reading, parts: out };
}

/** The `[partId, index]` of each change of `parts` that sits in the pending change at `position` of the reading. */
export function carriedBy(
  reading: DraftChangeReading,
  position: number,
): [partId: number, index: number][] {
  const out: [number, number][] = [];
  for (const [id, part] of reading.parts)
    part.changes.forEach((change, index) => {
      if (change.sitsIn.has(position)) out.push([id, index]);
    });
  return out;
}

/**
 * An Undo of what parts wrote into one text: each change of `parts` that still stands in `text` is
 * taken out of it, in the order given, and the parts that had one come back. Pass the review `base`
 * for an AI write's part in a draft: it stands only while it sits in a pending change. Live, a review
 * base and a writer's command part (a Discard's, say) are judged on the text alone. The one rule
 * every Undo applies, to committed text under its hold and, as the model's plan, to a copy of it.
 */
export function takeBack<P extends { delta: StoredDelta | null }>(
  text: readonly PMNode[],
  parts: readonly P[],
  base?: readonly PMNode[],
): { text: readonly PMNode[]; taken: P[] } {
  let blocks = text;
  const taken: P[] = [];
  for (const part of parts) {
    if (!part.delta) continue;
    for (const change of editChanges(schema, readDelta(schema, part.delta))) {
      const state = base
        ? changeState(schema, change, blocks, base)
        : changeStateIn(schema, change, blocks);
      if (state !== "stands") continue;
      blocks = takeOut(schema, change, blocks);
      if (!taken.includes(part)) taken.push(part);
    }
  }
  return { text: blocks, taken };
}
