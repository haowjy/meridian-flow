/** Scoped internal-link lookup over the authoritative Context catalog and Work authority. */
import {
  type ContextUriScheme,
  documentTitleFromUri,
  isProjectScopedScheme,
  matchDocumentPath,
  parseContextUri,
  resolveDocumentHref,
} from "@meridian/contracts";
import type { CatalogFileEntry, CatalogScope } from "@meridian/contracts/protocol";
import type { ProjectWorkAuthorityResolver } from "../projects/domain/work-authority.js";
import type { ContextCatalog } from "./ports/context-catalog.js";
import type {
  DocumentLinkResolver,
  ResolveDocumentLinkInput,
  ResolvedDocumentLink,
} from "./ports/document-link-resolver.js";

type Location = { scope: CatalogScope; scheme: ContextUriScheme; path: string };

export function createDocumentLinkResolver({
  catalog,
  workAuthorityResolver,
}: {
  catalog: ContextCatalog;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
}): DocumentLinkResolver {
  async function noWorkScope(projectId: ResolveDocumentLinkInput["projectId"]) {
    const work = await workAuthorityResolver.noWork(projectId);
    return work ? { kind: "work" as const, projectId, workId: work.workId } : null;
  }
  async function currentScope(input: ResolveDocumentLinkInput): Promise<CatalogScope | null> {
    if (!input.workId) return noWorkScope(input.projectId);
    const work = await workAuthorityResolver.byId(input.projectId, input.workId);
    return work ? { kind: "work", projectId: input.projectId, workId: work.workId } : null;
  }
  async function location(input: ResolveDocumentLinkInput, uri: string): Promise<Location | null> {
    const parsed = parseContextUri(uri);
    if (!parsed.ok || !parsed.value.path) return null;
    const { scheme, path, authority } = parsed.value;
    let scope: CatalogScope | null;
    if (scheme === "user") scope = { kind: "user", userId: input.userId };
    else if (isProjectScopedScheme(scheme)) scope = { kind: "project", projectId: input.projectId };
    else if (authority.kind === "none") scope = await noWorkScope(input.projectId);
    else if (authority.kind === "work") {
      const work = await workAuthorityResolver.bySlug(input.projectId, authority.workSlug);
      scope = work ? { kind: "work", projectId: input.projectId, workId: work.workId } : null;
    } else scope = await currentScope(input);
    return scope ? { scope, scheme, path } : null;
  }
  return {
    async resolve(input) {
      const { target } = input;
      const resolved =
        target.kind === "scheme"
          ? resolveDocumentHref(target.uri, null)
          : resolveDocumentHref(target.path, target.baseUri);
      if (!resolved) return null;
      const address = await location(input, resolved.uri);
      if (!address) return null;
      const files = (await catalog.snapshot(address.scope)).entries.flatMap((entry) => {
        if (entry.kind !== "file") return [];
        const parsed = parseContextUri(entry.uri);
        return parsed.ok && parsed.value.scheme === address.scheme
          ? [{ entry, path: parsed.value.path }]
          : [];
      });
      const match = matchDocumentPath(files, address.path, (file) => file.path);
      return match ? resolvedLink(match.entry) : null;
    },
  };
}

function resolvedLink(file: CatalogFileEntry): ResolvedDocumentLink | null {
  const parsed = parseContextUri(file.uri);
  if (!parsed.ok) return null;
  return {
    documentId: file.entryId,
    title: documentTitleFromUri(file.uri) ?? file.name,
    scheme: parsed.value.scheme,
    path: parsed.value.path,
    uri: file.uri,
    workId: file.scope.kind === "work" ? file.scope.workId : null,
  };
}
