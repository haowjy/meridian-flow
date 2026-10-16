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
  refreshProseMirrorDoc,
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
export function readBase(doc: Y.Doc, blockSchema = roomContent(doc).doc.type.schema): PMNode[] {
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
  const types = yDoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).toArray();
  for (const group of projection.groups) {
    const position = groupAnchor(group);
    let lo = 0;
    let hi = projection.blockStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (projection.blockStarts[mid] <= position) lo = mid + 1;
      else hi = mid;
    }
    const index = lo - 1;
    const node = blocks[index];
    const offset = position - projection.blockStarts[index];
    // A PM node alone is not CRDT identity: moving or recreating equal prose may replace its
    // Yjs items. Require both identities. Boundary pins depend on neighbours, so do not cache them.
    if (!node || offset === 0) {
      pins.set(group.id, pin(position));
      continue;
    }
    const type = types[index];
    let nodes = retainedPins.get(type);
    if (!nodes) {
      nodes = new WeakMap();
      retainedPins.set(type, nodes);
    }
    let offsets = nodes.get(node);
    if (!offsets) {
      offsets = new Map();
      nodes.set(node, offsets);
    }
    let relative = offsets.get(offset);
    if (!relative) {
      relative = pin(position);
      offsets.set(offset, relative);
    }
    pins.set(group.id, relative);
  }
  return { ...projection, doc: draft, snapshot: Y.snapshot(yDoc), pins };
}

const retainedPins = new WeakMap<object, WeakMap<PMNode, Map<number, Y.RelativePosition>>>();

// A room has one runtime, but headless Discard also reads it directly. Both must use the same
// retained nodes and current pin mapping, not a fresh conversion (or a second per-command cache).
const roomContents = new WeakMap<Y.Doc, ReturnType<typeof initProseMirrorDoc>>();
function roomContent(doc: Y.Doc) {
  let content = roomContents.get(doc);
  if (!content) {
    const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    const retained = initProseMirrorDoc(fragment, roomSchema());
    roomContents.set(doc, retained);
    const refresh = (_events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
      const next = refreshProseMirrorDoc(
        fragment,
        retained.doc.type.schema,
        retained.meta,
        transaction,
      );
      retained.doc = next.doc;
    };
    // Observe Yjs, not PM steps: remote writes and Undo are one whole-document replace step,
    // even though the binding preserves every untouched node's identity inside that replacement.
    fragment.observeDeep(refresh);
    doc.once("destroy", () => {
      fragment.unobserveDeep(refresh);
      roomContents.delete(doc);
    });
    content = retained;
  }
  return content;
}

/** Adopt the editor's schema and retained identities off the typing path, including after detach. */
export function adoptRoomEditor(
  doc: Y.Doc,
  root: PMNode,
  mapping: Map<Y.AbstractType<unknown>, PMNode>,
): void {
  const retained = roomContent(doc);
  retained.doc = root;
  retained.meta.mapping.clear();
  for (const [type, node] of mapping) retained.meta.mapping.set(type, node);
  retained.meta.isOMark.clear();
}

/** The review of a room nobody has open, read from its Yjs text alone. */
export function projectRoom(doc: Y.Doc, base: readonly PMNode[] = readBase(doc)): ReviewFrame {
  const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  const { doc: root, mapping } = roomContent(doc);
  return buildFrame(doc, base, root, (position) =>
    absolutePositionToRelativePosition(position, fragment, mapping),
  );
}

/** Where a pin made by an earlier frame stands in the room's text now, or null when it is gone. */
export function locateInRoom(doc: Y.Doc, pin: Y.RelativePosition): number | null {
  const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  const { mapping } = roomContent(doc);
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
