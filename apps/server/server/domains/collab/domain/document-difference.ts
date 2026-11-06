/** Identity-aware comparison of the committed live effect, for trail navigation only. */

import { isDeepStrictEqual } from "node:util";
import {
  type AgentEditCodec,
  type AgentEditModel,
  toDocHandle,
  unwrapBlock,
} from "@meridian/agent-edit/integration";
import type * as Y from "yjs";
import { visibleContent } from "./document-content.js";

export function describeTrailBlocks(doc: Y.Doc, model: AgentEditModel, codec: AgentEditCodec) {
  return model.projectBlocks(toDocHandle(doc)).map((block) => ({
    id: block.hash,
    identity: block.id,
    content: visibleContent(unwrapBlock(block.ref)),
    serialized: codec.serializeBlock(block.node, block.hash),
    block: unwrapBlock(block.ref),
  }));
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
