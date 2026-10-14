/**
 * The review of a draft room's text as one immutable frame (`ProjectedReview`): its `prosemirror` fragment
 * against its `review_base`, diffed and grouped, with the Yjs snapshot it was computed at and each change
 * pinned. Pure: no React, no editor. The room's runtime (`review-runtime.ts`) publishes frames; Apply sends a
 * frame's snapshot and Discard finds a frame's pinned change again in the text as it is now (`locateInRoom`).
 */
import {
  diffBlocks,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  type ReviewGroup,
  type ReviewProjection,
  readBlocks,
} from "@meridian/agent-edit/diff";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  absolutePositionToRelativePosition,
  initProseMirrorDoc,
  relativePositionToAbsolutePosition,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import type { AppliedChange } from "@/client/query/draft-command-record";
import { isSameChange, type ProjectedReview } from "@/core/editor/extensions/inline-review";

export type ReviewFrame = ProjectedReview;

let schema: ReturnType<typeof buildDocumentSchema> | null = null;
const roomSchema = () => (schema ??= buildDocumentSchema());

/** Draft position of a change's first mark, where the stepper scrolls to and the change is pinned. */
export function groupAnchor(group: ReviewGroup): number {
  return Math.min(...group.hunks.map((hunk) => hunk.inserted?.from ?? hunk.anchor));
}

/** The base blocks of a room's `review_base`: read once per base change by whoever keeps them. */
export function readBase(doc: Y.Doc, blockSchema = roomSchema()): PMNode[] {
  return readBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), blockSchema);
}

/**
 * A frame of `draft` (a document whose top-level nodes are the draft's blocks) against `base`. `pin` turns
 * a position of `draft` into a Yjs position; the editor and a headless read each supply their own mapping.
 */
export function buildFrame(
  yDoc: Y.Doc,
  base: readonly PMNode[],
  draft: PMNode,
  pin: (position: number) => Y.RelativePosition,
): ReviewFrame {
  const blocks: PMNode[] = [];
  draft.forEach((node) => {
    blocks.push(node);
  });
  const projection: ReviewProjection = projectReview(diffBlocks(base, blocks));
  const pins = new Map<string, Y.RelativePosition>();
  for (const group of projection.groups) pins.set(group.id, pin(groupAnchor(group)));
  return { ...projection, doc: draft, snapshot: Y.snapshot(yDoc), pins };
}

/** The review of a room nobody has open, read from its Yjs text alone. */
export function projectRoom(doc: Y.Doc, base: readonly PMNode[] = readBase(doc)): ReviewFrame {
  const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  const { doc: root, mapping } = initProseMirrorDoc(fragment, roomSchema());
  return buildFrame(doc, base, root, (position) =>
    absolutePositionToRelativePosition(position, fragment, mapping),
  );
}

/** Where a pin made by an earlier frame stands in the room's text now, or null when it is gone. */
export function locateInRoom(doc: Y.Doc, pin: Y.RelativePosition): number | null {
  const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  const { mapping } = initProseMirrorDoc(fragment, roomSchema());
  return relativePositionToAbsolutePosition(doc, fragment, pin, mapping);
}

const baseKeys = new WeakMap<readonly PMNode[], string>();

/** The text of a frame's `review_base`: equal bases give equal keys, and any base patch changes it. */
export function baseKeyOf(frame: Pick<ReviewProjection, "diff">): string {
  const blocks = frame.diff.base.blocks;
  let key = baseKeys.get(blocks);
  if (key === undefined) {
    key = blocks.map((block) => block.toString()).join("\n");
    baseKeys.set(blocks, key);
  }
  return key;
}

/**
 * The ids, in this frame, of the changes the writer applied, and the applied entries still in force. An
 * entry names its change by the pin and hash it was clicked as (`isSameChange`), so a frame newer than the
 * click hides the change that was applied and never an unrelated twin that inherited its id. A confirmed
 * entry whose base moved on is retired by the runtime's reconcile; it hides nothing meanwhile.
 */
export function appliedIn(
  frame: Pick<ReviewFrame, "groups" | "diff" | "pins">,
  entries: readonly AppliedChange[],
): { ids: ReadonlySet<string>; live: readonly AppliedChange[] } {
  if (entries.length === 0) return { ids: new Set(), live: entries };
  const base = baseKeyOf(frame);
  const live = entries.filter((entry) => entry.phase !== "settled" || entry.baseKey === base);
  const ids = new Set<string>();
  for (const group of frame.groups)
    if (live.some((entry) => isSameChange(entry, group.id, frame.pins.get(group.id))))
      ids.add(group.id);
  return { ids, live };
}
