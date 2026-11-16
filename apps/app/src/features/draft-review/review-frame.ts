/** One immutable text projection and room snapshot. Every position belongs to its exact PM document. */
import {
  blocksEqual,
  diffBlocks,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  type ReviewGroup,
  type ReviewProjection,
} from "@meridian/agent-edit/diff";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import {
  initProseMirrorDoc,
  type ProsemirrorMapping,
  refreshProseMirrorDoc,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import type { ProjectedReview } from "@/core/editor/extensions/inline-review";

export type ReviewFrame = ProjectedReview;

let schema: ReturnType<typeof buildDocumentSchema> | null = null;
const roomSchema = () => (schema ??= buildDocumentSchema());

export const inSchema = (schema: Schema, blocks: readonly PMNode[]) =>
  blocks.every((block) => block.type.schema === schema)
    ? blocks
    : blocks.map((block) => schema.nodeFromJSON(block.toJSON()));

const family = (id: string) => id.replace(/~\d+$/, "");
const range = (tokens: "baseTokens" | "draftTokens", group: ReviewGroup) =>
  group.hunks.map((h) => `${h[tokens].from}-${h[tokens].to}`).join(",");

/**
 * The changes chosen on `shown` as `read` names them. Identical edits share an id up to the `~n`
 * they take in document order, so one id can name another edit in the other frame; where the two
 * frames share their draft, the draft tokens an edit covers tell repeats apart, where they share
 * their base, the base tokens it replaces do, and otherwise only an edit with no repeat in either
 * frame is named. A chosen change `read` has no name for is in `stayed`.
 */
export function readChosen(
  shown: ReviewFrame,
  read: ReviewFrame,
  chosen: readonly string[],
): { going: { shown: string; read: string }[]; stayed: string[] } {
  const schema = read.doc.type.schema;
  const sameDraft = blocksEqual(read.diff.draft.blocks, inSchema(schema, shown.diff.draft.blocks));
  const sameBase = blocksEqual(read.diff.base.blocks, inSchema(schema, shown.diff.base.blocks));
  const going: { shown: string; read: string }[] = [];
  for (const group of shown.groups) {
    if (!chosen.includes(group.id)) continue;
    const repeats = (groups: readonly ReviewGroup[]) =>
      groups.filter((other) => family(other.id) === family(group.id));
    const candidates = repeats(read.groups);
    const named = sameDraft
      ? candidates.find((other) => range("draftTokens", other) === range("draftTokens", group))
      : sameBase
        ? candidates.find((other) => range("baseTokens", other) === range("baseTokens", group))
        : repeats(shown.groups).length === 1 && candidates.length === 1
          ? candidates[0]
          : undefined;
    if (named) going.push({ shown: group.id, read: named.id });
  }
  return { going, stayed: chosen.filter((id) => !going.some((pair) => pair.shown === id)) };
}

/** Draft position of a change's first mark, where the stepper scrolls to. */
export function groupAnchor(group: ReviewGroup): number {
  return Math.min(...group.hunks.map((hunk) => hunk.inserted?.from ?? hunk.anchor));
}

const bases = new WeakMap<
  Y.XmlFragment,
  { content: ReturnType<typeof retainFragment>; root: PMNode | null; blocks: PMNode[] }
>();

/** Retain the base's unchanged nodes and block array, just as the mounted draft binding does. */
export function readBase(doc: Y.Doc, blockSchema = roomContent(doc).doc.type.schema): PMNode[] {
  const fragment = doc.getXmlFragment(REVIEW_BASE_FRAGMENT);
  let base = bases.get(fragment);
  if (!base || base.content.doc.type.schema !== blockSchema) {
    base?.content.dispose();
    base = { content: retainFragment(fragment, blockSchema), root: null, blocks: [] };
    bases.set(fragment, base);
  }
  if (base.root !== base.content.doc) {
    base.root = base.content.doc;
    base.blocks = [];
    base.root.forEach((node) => {
      base.blocks.push(node);
    });
  }
  return base.blocks;
}

/**
 * A frame of `draft` (a document whose top-level nodes are the draft's blocks) against `base`. Its positions belong to that exact document.
 */
export function buildFrame(yDoc: Y.Doc, base: readonly PMNode[], draft: PMNode): ReviewFrame {
  const blocks: PMNode[] = [];
  draft.forEach((node) => {
    blocks.push(node);
  });
  // The editor fills an emptied draft with one empty paragraph that an empty base lacks. It is no
  // change: the writer did not make it.
  const from = base.length === 0 && blocksEqual(base, blocks) ? blocks : base;
  const projection: ReviewProjection = projectReview(diffBlocks(from, blocks));
  return { ...projection, doc: draft, snapshot: Y.snapshot(yDoc) };
}

// A room has one runtime, but headless Discard also reads it directly. Both must use the same
// retained nodes, not a fresh conversion or a second per-command cache.
const roomContents = new WeakMap<Y.Doc, ReturnType<typeof initProseMirrorDoc>>();
export function roomContent(doc: Y.Doc) {
  let content = roomContents.get(doc);
  if (!content) {
    const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    const retained = retainFragment(fragment, roomSchema());
    roomContents.set(doc, retained);
    doc.once("destroy", () => roomContents.delete(doc));
    content = retained;
  }
  return content;
}

function retainFragment(fragment: Y.XmlFragment, schema: Schema) {
  const retained = initProseMirrorDoc(fragment, schema);
  const refresh = (_events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
    retained.doc = refreshProseMirrorDoc(
      fragment,
      retained.doc.type.schema,
      retained.meta,
      transaction,
    ).doc;
  };
  const dispose = () => {
    fragment.unobserveDeep(refresh);
    fragment.doc?.off("destroy", dispose);
  };
  fragment.observeDeep(refresh);
  fragment.doc?.on("destroy", dispose);
  return Object.assign(retained, { dispose });
}

/** Adopt the editor's schema and retained identities off the typing path, including after detach. */
export function adoptRoomEditor(doc: Y.Doc, root: PMNode, mapping: ProsemirrorMapping): void {
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
