import type { HolderLinkScope } from "@meridian/markup/links";
import type { AgentEditCodec, AgentEditCodecFactory } from "../codec-adapter.js";
import type { DocumentLinksPort, LinkPrepareRequest } from "../ports/document-links.js";

export interface CommandLinks {
  codec: AgentEditCodec;
  scope: HolderLinkScope;
}

export interface CommandLinksDeps {
  codec: AgentEditCodecFactory;
  codecFor?(documentId: string): Promise<AgentEditCodecFactory>;
  links: Pick<DocumentLinksPort, "prepare" | "scopeFor">;
}

/** Prepare the scope (the one await), then take its codec synchronously; call at the entry of every command. */
export async function openCommandLinks(
  deps: CommandLinksDeps,
  request: LinkPrepareRequest,
): Promise<CommandLinks> {
  await deps.links.prepare(request);
  const scope = deps.links.scopeFor(request.documentId, request.context);
  const codecs = (await deps.codecFor?.(request.documentId)) ?? deps.codec;
  return { scope, codec: codecs.forScope(scope) };
}
