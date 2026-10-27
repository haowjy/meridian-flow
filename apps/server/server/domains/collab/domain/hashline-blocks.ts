/** A document's blocks as a hashline read reports them, projected once. */
import { bodyRange, destinationFreeBlocks } from "@meridian/agent-edit";
import type {
  AgentEditCodec,
  AgentEditCodecFactory,
  DocHandle,
  YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import { spelledLinks } from "@meridian/markup/links";
import type { HashlineBlock, HashlineRead } from "../contracts.js";
import type { HolderLinkScope } from "./ports/document-link-scope.js";

export function hashlineBlocks(input: {
  model: YProsemirrorDocumentModel;
  markup: AgentEditCodecFactory["markup"];
  codec: AgentEditCodec;
  scope: HolderLinkScope;
  doc: DocHandle;
}): HashlineBlock[] {
  const { model, doc, scope } = input;
  const projected = model.projectBlocks(doc);
  const hashes = model.getDocumentBlockIds(doc);
  const bodies = input.codec.serializeBlockBodies(projected);
  const destinationFree = destinationFreeBlocks(input.markup, projected);
  return projected.map((block, index) => ({
    hash: hashes[index] as string,
    body: bodies[index] as string,
    destinationFree: destinationFree[index] as string,
    links: spelledLinks([block], scope),
  }));
}

/** {@link HashlineRead.locate} for a codec's markup. */
export function locateInBody(markup: AgentEditCodecFactory["markup"]): HashlineRead["locate"] {
  return (block, range) => bodyRange(markup, block.destinationFree, block.body, range);
}
