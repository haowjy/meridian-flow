import { createHash } from "node:crypto";
import { bodyRange } from "@meridian/agent-edit";
import type {
  AgentEditCodecFactory,
  AgentEditModel,
  DocHandle,
  DocumentCut,
} from "@meridian/agent-edit/integration";
import { spelledLinks, walkLinkOccurrences } from "@meridian/markup/links";
import type { HashlineRead } from "../contracts.js";
import { grepBlocksOf } from "./grep-blocks.js";
import type { HolderLinkScope } from "./ports/document-link-scope.js";

export function cutRevision(cut: DocumentCut, scope: HolderLinkScope): string {
  const triples = new Set<string>();
  for (const { kind, attrs } of walkLinkOccurrences(cut.blocks)) {
    const asset = kind !== "link" && attrs.href.startsWith("asset:");
    if (attrs.ref === null && !asset) continue;
    const spelled =
      kind === "link"
        ? scope.spellLink({ href: attrs.href, ref: attrs.ref })
        : scope.spellSource({ src: attrs.href, ref: attrs.ref });
    triples.add(JSON.stringify([attrs.ref, attrs.href, spelled.href]));
  }
  return `l1:${createHash("sha256")
    .update(cut.version)
    .update(Uint8Array.of(0))
    .update(scope.holder.uri ?? "", "utf8")
    .update(Uint8Array.of(0))
    .update(JSON.stringify([...triples].sort()), "utf8")
    .digest("base64url")}`;
}

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
