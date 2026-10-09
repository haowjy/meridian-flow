// Binds a command to one holder's prepared link scope: the codec it serializes with and the scope its revision reads.
import type { AgentEditCodec, AgentEditCodecFactory } from "../codec-adapter.js";
import type {
  DocumentLinksPort,
  HolderLinkScope,
  LinkPrepareRequest,
} from "../ports/document-links.js";

/** One command's link binding: every serialization and the revision use the same scope. */
export interface BoundLinks {
  codec: AgentEditCodec;
  scope: HolderLinkScope;
}

export interface LinkBindingDeps {
  codec: AgentEditCodecFactory;
  links: DocumentLinksPort;
}

/** Prepare (the one await), then bind synchronously; call at the entry of every command. */
export async function bindLinks(
  deps: LinkBindingDeps,
  request: LinkPrepareRequest,
): Promise<BoundLinks> {
  await deps.links.prepare(request);
  const scope = deps.links.scopeFor(request.documentId, request.context);
  return { scope, codec: deps.codec.bind(scope) };
}
