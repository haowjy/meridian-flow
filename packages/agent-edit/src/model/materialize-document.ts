/** Materialize whole-document nodes with fresh CRDT/block identity, retaining stored link refs. */
import type { PMNode } from "@meridian/markup";
import type * as Y from "yjs";
import { toDocHandle } from "../handles.js";
import type { AgentEditModel } from "../ports/model.js";

export function materializeDocument(
  doc: Y.Doc,
  model: AgentEditModel,
  blocks: readonly PMNode[],
  origin?: unknown,
): string[] {
  let inserted: string[] = [];
  doc.transact(() => {
    inserted = model
      .insertBlocks(toDocHandle(doc), null, { blocks: [...blocks] })
      .map((block) => model.getBlockId(block));
  }, origin);
  return inserted;
}
