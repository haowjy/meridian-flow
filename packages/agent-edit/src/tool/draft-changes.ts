// `read` with `format: "changes"` (design §1, "What the AI reads"): a draft's pending changes
// against Live as CriticMarkup, from the changes Review changes shows (`changedBlocks`).
import {
  type BlockId,
  type CommentBody,
  changedBlocks,
  type RoomDocs,
  type ShapeBlock,
  structureValues,
} from "@meridian/document-model";
import type { Node as PMNode, Schema } from "prosemirror-model";
import type { AgentEditCodec } from "../codec-adapter.js";
import { wordDiff } from "../diff/tokens.js";
import { toHashline } from "../model/hashline.js";
import { LoroDocument, type LoroDocumentModel, toLoroHandle } from "../model/loro-model.js";
import type { ProjectedBlock } from "../ports/model.js";

/**
 * The draft's pending changes, one line each:
 * - each top-level block holding a change, in the draft's order with a block only Live shows after
 *   the Live block before it, as a `hash|body` line: Live's text to the draft's, word by word, as
 *   CriticMarkup (`{++added++}`, `{--removed--}`, `{~~old~>new~~}`). A block only one side shows
 *   is wrapped whole; one that moved starts `{>>moved<<}`.
 * - each comment whose body the draft changed, as `comment on <hashes>: ` and its body's change.
 *
 * The model reads Markdown, so a closing delimiter in the text is escaped (`++\}`). `docs` is a
 * draft copy, forwarded (a room's read is).
 */
export function draftChangeLines(
  docs: RoomDocs,
  schema: Schema,
  model: LoroDocumentModel,
  codec: AgentEditCodec,
): string[] {
  const live = docs.live;
  if (!live) throw new Error("draftChangeLines needs a draft copy");
  const changes = changedBlocks(docs);
  if (changes.length === 0) return [];
  const fork = side(new LoroDocument(docs, schema), model, codec);
  const base = side(new LoroDocument(live, schema), model, codec);
  const tops = new Set(
    changes
      .flatMap((change) => change.blocks)
      .map((id) => fork.topOf.get(id) ?? base.topOf.get(id)),
  );

  // Live-only blocks go after the nearest Live block before them that the draft shows too.
  const after = new Map<BlockId | null, BlockId[]>();
  let anchor: BlockId | null = null;
  for (const id of base.order) {
    if (fork.body.has(id)) anchor = id;
    else after.set(anchor, [...(after.get(anchor) ?? []), id]);
  }
  const order = [...(after.get(null) ?? [])];
  for (const id of fork.order) order.push(id, ...(after.get(id) ?? []));

  const forkValues = structureValues(docs);
  const liveValues = structureValues(live);
  const moved = (id: BlockId) =>
    fork.body.has(id) &&
    base.body.has(id) &&
    (["parent", "order"] as const).some(
      (map) => forkValues.value(map, id) !== liveValues.value(map, id),
    );
  const hashOf = (id: BlockId) => (fork.hash.get(id) ?? base.hash.get(id)) as string;

  const blockLines = order
    .filter((id) => tops.has(id))
    .map((id) => {
      const was = base.body.get(id);
      const now = fork.body.get(id);
      const body =
        was === undefined
          ? `{++${escaped(now as string)}++}`
          : now === undefined
            ? `{--${escaped(was)}--}`
            : critic(was, now);
      return toHashline(hashOf(id), `${moved(id) ? "{>>moved<<}" : ""}${body}`);
    });

  const commentLines = changes.flatMap((change) =>
    change.comments.map((comment) => {
      const was = liveValues.value("comments", comment) as CommentBody | null | undefined;
      const now = forkValues.value("comments", comment) as CommentBody | null | undefined;
      const carriers = order.filter(
        (id) => fork.comments.get(id)?.has(comment) || base.comments.get(id)?.has(comment),
      );
      const on = carriers.length ? ` on ${carriers.map(hashOf).join(", ")}` : "";
      return `comment${on}: ${commentChange(was ?? null, now ?? null)}`;
    }),
  );
  return [...blockLines, ...commentLines];
}

function commentChange(was: CommentBody | null, now: CommentBody | null): string {
  if (!was) return now ? `{++${escaped(now.body)}++}` : "";
  if (!now) return `{--${escaped(was.body)}--}`;
  const state =
    was.resolved === now.resolved ? "" : now.resolved ? "{>>resolved<<}" : "{>>reopened<<}";
  return `${state}${critic(was.body, now.body)}`;
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
    comments: new Map(projected.map((block) => [block.key, commentsIn(block.node)])),
  };
}

function commentsIn(node: PMNode): Set<string> {
  const out = new Set<string>();
  node.descendants((child) => {
    for (const mark of child.marks)
      if (mark.type.name === "comment" && typeof mark.attrs.id === "string") out.add(mark.attrs.id);
  });
  return out;
}

function critic(was: string, now: string): string {
  const parts = wordDiff(was, now);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const next = parts[i + 1];
    if (part.kind === "same") out += escaped(part.text);
    else if (next && next.kind !== "same") {
      const [was, now] = part.kind === "removed" ? [part, next] : [next, part];
      out += `{~~${escaped(was.text)}~>${escaped(now.text)}~~}`;
      i++;
    } else
      out += part.kind === "added" ? `{++${escaped(part.text)}++}` : `{--${escaped(part.text)}--}`;
  }
  return out;
}

/** Text with no CriticMarkup delimiter left whole in it: each closing one and `~>` escaped. */
const escaped = (text: string) => text.replace(/([+\-~<=])\}/g, "$1\\}").replace(/~>/g, "~\\>");
