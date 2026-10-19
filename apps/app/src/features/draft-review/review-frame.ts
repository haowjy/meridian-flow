/** One immutable text projection and room snapshot. Every position belongs to its exact PM document. */
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
import { initProseMirrorDoc, refreshProseMirrorDoc } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import type { ProjectedReview } from "@/core/editor/extensions/inline-review";

export type ReviewFrame = ProjectedReview;

let schema: ReturnType<typeof buildDocumentSchema> | null = null;
const roomSchema = () => (schema ??= buildDocumentSchema());

/** Draft position of a change's first mark, where the stepper scrolls to. */
export function groupAnchor(group: ReviewGroup): number {
  return Math.min(...group.hunks.map((hunk) => hunk.inserted?.from ?? hunk.anchor));
}

/** The base blocks of a room's `review_base`: read once per base change by whoever keeps them. */
export function readBase(doc: Y.Doc, blockSchema = roomContent(doc).doc.type.schema): PMNode[] {
  return readBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), blockSchema);
}

/**
 * A frame of `draft` (a document whose top-level nodes are the draft's blocks) against `base`. Its positions belong to that exact document.
 */
export function buildFrame(yDoc: Y.Doc, base: readonly PMNode[], draft: PMNode): ReviewFrame {
  const blocks: PMNode[] = [];
  draft.forEach((node) => {
    blocks.push(node);
  });
  const projection: ReviewProjection = projectReview(diffBlocks(base, blocks));
  return { ...projection, doc: draft, snapshot: Y.snapshot(yDoc) };
}

// A room has one runtime, but headless Discard also reads it directly. Both must use the same
// retained nodes, not a fresh conversion or a second per-command cache.
const roomContents = new WeakMap<Y.Doc, ReturnType<typeof initProseMirrorDoc>>();
export function roomContent(doc: Y.Doc) {
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
  const { doc: root } = roomContent(doc);
  return buildFrame(doc, base, root);
}
