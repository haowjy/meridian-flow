import { bodyRange } from "@meridian/agent-edit";
import {
  type AgentEditCodecFactory,
  type AgentEditModel,
  cutRevision,
  type DocHandle,
} from "@meridian/agent-edit/integration";
import { spelledLinks } from "@meridian/markup/links";
import type { HashlineRead } from "../contracts.js";
import { grepBlocksOf } from "./grep-blocks.js";
import type { HolderLinkScope } from "./ports/document-link-scope.js";

export function viewRevision(revision: string, draft: string | null): string {
  return draft ? `${revision}:${draft}` : revision;
}

export function inView<T extends { revision: string | null }>(read: T, draft: string | null): T {
  return draft && read.revision ? { ...read, revision: viewRevision(read.revision, draft) } : read;
}

export function readHashlines(
  doc: DocHandle,
  version: Uint8Array,
  scope: HolderLinkScope,
  model: AgentEditModel,
  codecs: AgentEditCodecFactory,
  verbatim: boolean,
): HashlineRead {
  const grepBlocks = grepBlocksOf(doc, model, codecs.markup, verbatim);
  const bodies = codecs.forScope(scope).serializeBlocks(
    grepBlocks.map(({ block }) => block.node),
    grepBlocks.map(({ block }) => block.hash),
  );
  return {
    blocks: grepBlocks.map(({ block, destinationFree, text }, index) => ({
      hash: block.hash,
      body: bodies[index] as string,
      destinationFree,
      text,
      verbatim,
      links: spelledLinks([block.node], scope),
    })),
    revision: cutRevision({ version, blocks: grepBlocks.map(({ block }) => block.node) }, scope),
    holder: { uri: scope.holder.uri, view: scope.holder.view },
    locate: (block, range) => bodyRange(codecs.markup, block.destinationFree, block.body, range),
  };
}
