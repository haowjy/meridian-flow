import { withoutBlockIds } from "@meridian/prosemirror-schema";
import type { Node as PMNode, Schema } from "prosemirror-model";
import * as Y from "yjs";
import { applyEdits } from "../apply/apply-edits.js";
import type { ResolvedEdit } from "../apply/types.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import { contentMerge } from "../content-merge/index.js";
import { writeBlocks } from "../diff/index.js";
import { type DocHandle, toDocHandle } from "../handles.js";
import {
  type BlockItemId,
  bindBlockOrigins,
  blockIdentityForItem,
  blockItemIdKey,
  fullHashForItemId,
  getBlockItemId,
  getTopLevelXmlBlocks,
} from "../model/block-hash.js";
import { fragmentOf } from "../model/y-prosemirror.js";
import type { AgentEditModel } from "../ports/model.js";

/** One block a result showed the model in full, in the view it was read in; later showings last. */
export interface ShownBlock {
  hash: string;
  body: string;
  view: "live" | "draft";
}

/**
 * The content of a whole-document replace that writes `plan`'s edit onto the room as a merge
 * with what the model read (base: each block as last shown in full, else Live; ours: base plus
 * the edit; theirs: the room), or null when the transcript can't stand in for the read: no block
 * of the frontier was shown in full, a body doesn't parse as one block, or the edit doesn't
 * resolve on the read.
 */
export function readMergedContent(input: {
  room: Y.Doc;
  snapshot: Y.Snapshot;
  shown: readonly ShownBlock[];
  model: AgentEditModel;
  codec: AgentEditCodec;
  /** The model's command, resolved on a document: its edits, or null when it doesn't resolve. */
  plan: (doc: DocHandle) => readonly ResolvedEdit[] | null;
}): string | null {
  const { room, model, codec } = input;
  const seen = blocksAt(room, input.snapshot);
  const bodies = shownBodies(seen, input.shown);
  if (bodies.size === 0) return null;

  const live = model.projectBlocks(toDocHandle(room)).map((block) => ({
    key: blockItemIdKey(blockIdentityForItem(room, block.id)),
    node: block.node,
  }));
  const schema = live[0]?.node.type.schema;
  if (!schema) return null;
  const now = new Map(live.map((block) => [block.key, block.node]));

  const base: { key: string; identity: BlockItemId; node: PMNode }[] = [];
  for (const identity of seen) {
    const key = blockItemIdKey(identity);
    const body = bodies.get(key);
    if (body !== undefined) {
      const parsed = codec.parse(body).blocks;
      if (parsed.length !== 1) return null;
      base.push({ key, identity, node: parsed[0] as PMNode });
    } else {
      const node = now.get(key);
      if (node) base.push({ key, identity, node });
    }
  }

  const read = new Y.Doc({ gc: false });
  try {
    writeBlocks(
      fragmentOf(read),
      schema,
      base.map((block) => keyed(schema, block.node, block.key)),
    );
    const elements = getTopLevelXmlBlocks(read);
    if (elements.length !== base.length) return null;
    bindBlockOrigins(
      read,
      new Map(
        elements.map((element, index) => [
          blockItemIdKey(getBlockItemId(element)),
          base[index].identity,
        ]),
      ),
    );
    const handle = toDocHandle(read);
    const edits = input.plan(handle);
    if (!edits) return null;
    if (!applyEdits(handle, model, edits, "read-view").ok) return null;
    const ours = model
      .projectBlocks(handle)
      .map((block) =>
        keyed(schema, block.node, blockItemIdKey(blockIdentityForItem(read, block.id))),
      );
    const merged = contentMerge(
      schema,
      base.map((block) => keyed(schema, block.node, block.key)),
      live.map((block) => keyed(schema, block.node, block.key)),
      ours,
    );
    return codec.serialize(merged.blocks.map((block) => withoutBlockIds(block) as PMNode));
  } finally {
    read.destroy();
  }
}

/**
 * The identities of the top-level blocks visible at `snapshot`, in document order: every item of
 * the fragment, deleted or collected ones included, keeps its place in the list.
 */
function blocksAt(room: Y.Doc, snapshot: Y.Snapshot): BlockItemId[] {
  const out: BlockItemId[] = [];
  for (let item = fragmentOf(room)._start; item; item = item.right) {
    if (!(item.content instanceof Y.ContentType || item.content instanceof Y.ContentDeleted))
      continue;
    if (item.content instanceof Y.ContentType && !(item.content.type instanceof Y.XmlElement))
      continue;
    // A collected run of deleted blocks can merge into one item: each clock is one block.
    for (let offset = 0; offset < item.length; offset += 1) {
      const id = Y.createID(item.id.client, item.id.clock + offset);
      if (id.clock >= (snapshot.sv.get(id.client) ?? 0) || Y.isDeleted(snapshot.ds, id)) continue;
      out.push(blockIdentityForItem(room, { clientID: id.client, clock: id.clock }));
    }
  }
  return out;
}

/**
 * Each block's latest full showing, by identity key. A shown hash is a prefix unique among the
 * blocks the model saw; a block made since can't match one, since it is not visible at the
 * frontier, so a prefix naming more than one of them is left out.
 */
function shownBodies(seen: readonly BlockItemId[], shown: readonly ShownBlock[]) {
  const full = seen.map((identity) => ({
    key: blockItemIdKey(identity),
    hash: fullHashForItemId(identity),
  }));
  const bodies = new Map<string, string>();
  for (const block of shown) {
    const prefix = block.hash.trim().toLowerCase();
    const matches = full.filter((candidate) => candidate.hash.startsWith(prefix));
    if (matches.length === 1) bodies.set(matches[0].key, block.body);
  }
  return bodies;
}

function keyed(schema: Schema, node: PMNode, key: string): PMNode {
  const json = node.toJSON() as { attrs?: Record<string, unknown> };
  return schema.nodeFromJSON({ ...json, attrs: { ...json.attrs, id: key } });
}
