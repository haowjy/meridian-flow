// `read` with `format: "changes"` (design §1, "What the AI reads"): a draft's pending changes
// against Live as CriticMarkup, from the block changes Review changes shows (`changedBlocks`).
import {
  type BlockId,
  changedBlocks,
  type RoomDocs,
  type ShapeBlock,
  wordDiff,
} from "@meridian/document-model";
import type { Schema } from "prosemirror-model";
import type { AgentEditCodec } from "../codec-adapter.js";
import { toHashline } from "../model/hashline.js";
import { LoroDocument, type LoroDocumentModel, toLoroHandle } from "../model/loro-model.js";
import type { ProjectedBlock } from "../ports/model.js";

/**
 * Each top-level block holding a pending change, in the draft's order with a block only Live shows
 * after the Live block before it, as a `hash|body` line: Live's text to the draft's, word by word,
 * as CriticMarkup (`{++added++}`, `{--removed--}`, `{~~old~>new~~}`). A block only one side shows
 * is wrapped whole. `docs` is a draft copy, forwarded (a room's read is).
 */
export function draftChangeLines(
  docs: RoomDocs,
  schema: Schema,
  model: LoroDocumentModel,
  codec: AgentEditCodec,
): string[] {
  const live = docs.live;
  if (!live) throw new Error("draftChangeLines needs a draft copy");
  const changed = changedBlocks(docs).flatMap((change) => change.blocks);
  if (changed.length === 0) return [];
  const fork = side(new LoroDocument(docs, schema), model, codec);
  const base = side(new LoroDocument(live, schema), model, codec);
  const tops = new Set(changed.map((id) => fork.topOf.get(id) ?? base.topOf.get(id)));

  // Live-only blocks go after the nearest Live block before them that the draft shows too.
  const after = new Map<BlockId | null, BlockId[]>();
  let anchor: BlockId | null = null;
  for (const id of base.order) {
    if (fork.body.has(id)) anchor = id;
    else after.set(anchor, [...(after.get(anchor) ?? []), id]);
  }
  const order = [...(after.get(null) ?? [])];
  for (const id of fork.order) order.push(id, ...(after.get(id) ?? []));

  return order
    .filter((id) => tops.has(id))
    .map((id) => {
      const was = base.body.get(id);
      const now = fork.body.get(id);
      const body =
        was === undefined ? `{++${now}++}` : now === undefined ? `{--${was}--}` : critic(was, now);
      return toHashline((fork.hash.get(id) ?? base.hash.get(id)) as string, body);
    });
}

function side(doc: LoroDocument, model: LoroDocumentModel, codec: AgentEditCodec) {
  const topOf = new Map<BlockId, BlockId>();
  const walk = (block: ShapeBlock, root: BlockId) => {
    topOf.set(block.id, root);
    if (block.kind === "container") for (const child of block.children) walk(child, root);
  };
  for (const block of doc.top()) walk(block, block.id);
  const projected: readonly ProjectedBlock[] = model.projectBlocks(toLoroHandle(doc));
  const entries = codec.serializeSelection(
    projected.map((block) => block.node),
    projected.map((block) => block.hash),
    projected.map((_, index) => index),
  );
  return {
    topOf,
    order: projected.map((block) => block.key),
    body: new Map(projected.map((block, index) => [block.key, entries[index].body])),
    hash: new Map(projected.map((block) => [block.key, block.hash])),
  };
}

function critic(was: string, now: string): string {
  const parts = wordDiff(was, now);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const next = parts[i + 1];
    if (part.kind === "same") out += part.text;
    else if (next && next.kind !== "same") {
      const [was, now] = part.kind === "removed" ? [part, next] : [next, part];
      out += `{~~${was.text}~>${now.text}~~}`;
      i++;
    } else out += part.kind === "added" ? `{++${part.text}++}` : `{--${part.text}--}`;
  }
  return out;
}
