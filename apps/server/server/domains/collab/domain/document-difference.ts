/** Identity-aware comparison of the committed live effect, for trail navigation only. */

import { isDeepStrictEqual } from "node:util";
import { readBlocks } from "@meridian/agent-edit/diff";
import {
  type AgentEditCodec,
  type AgentEditModel,
  getBlockItemId,
  toDocHandle,
  unwrapBlock,
} from "@meridian/agent-edit/integration";
import type { Schema } from "prosemirror-model";
import type * as Y from "yjs";
import { visibleContent } from "./document-content.js";

export function describeTrailBlocks(
  doc: Y.Doc,
  model: AgentEditModel,
  codec: AgentEditCodec,
  schema: Schema,
) {
  const nodes = readBlocks(doc.getXmlFragment("prosemirror"), schema);
  const ids = model.getDocumentBlockIds(toDocHandle(doc));
  return model.getBlocks(toDocHandle(doc)).map((block, index) => {
    const identity = getBlockItemId(unwrapBlock(block));
    const id = ids[index];
    return {
      id,
      identity,
      content: visibleContent(unwrapBlock(block)),
      serialized: codec.serializeBlock(nodes[index], id),
      block: unwrapBlock(block),
    };
  });
}

export function trailBlockChanges(
  before: ReturnType<typeof describeTrailBlocks>,
  after: ReturnType<typeof describeTrailBlocks>,
) {
  const key = (block: (typeof before)[number]) =>
    `${block.identity.clientID}:${block.identity.clock}`;
  const old = new Map(before.map((block) => [key(block), block]));
  const next = new Map(after.map((block) => [key(block), block]));
  return [
    ...before.flatMap((block) => {
      const target = next.get(key(block));
      return target && isDeepStrictEqual(block.content, target.content)
        ? []
        : [
            {
              blockId: block.id,
              beforeBlockIdentity: block.identity,
              afterBlockIdentity: target?.identity ?? null,
              beforeText: block.serialized,
              afterText: target?.serialized ?? null,
            },
          ];
    }),
    ...after
      .filter((block) => !old.has(key(block)))
      .map((block) => ({
        blockId: block.id,
        beforeBlockIdentity: null,
        afterBlockIdentity: block.identity,
        beforeText: null,
        afterText: block.serialized,
      })),
  ];
}
