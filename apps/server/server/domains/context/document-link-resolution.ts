/** Scoped internal-link lookup over the authoritative Context catalog and Work authority. */
import { type ContextUriScheme, documentTitleFromUri, parseContextUri } from "@meridian/contracts";
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
  async function currentScope(input: ResolveDocumentLinkInput): Promise<CatalogScope | null> {
    if (!input.workId) return { kind: "none", projectId: input.projectId };
    const work = await workAuthorityResolver.byId(input.projectId, input.workId);
    return work ? { kind: "work", projectId: input.projectId, workId: work.workId } : null;
  }
  async function location(input: ResolveDocumentLinkInput, uri: string): Promise<Location | null> {
    if (!uri.includes("://")) return null;
    const parsed = parseContextUri(uri);
    if (!parsed.ok || !parsed.value.path) return null;
    const { scheme, path, authority } = parsed.value;
    let scope: CatalogScope | null;
    if (scheme === "user") scope = { kind: "user", userId: input.userId };
    else if (scheme === "manuscript" || scheme === "kb")
      scope = { kind: "project", projectId: input.projectId };
    else if (authority.kind === "none") scope = { kind: "none", projectId: input.projectId };
    else if (authority.kind === "work") {
      const work = await workAuthorityResolver.bySlug(input.projectId, authority.workSlug);
      scope = work ? { kind: "work", projectId: input.projectId, workId: work.workId } : null;
    } else scope = await currentScope(input);
    return scope ? { scope, scheme, path } : null;
  }
  async function files(scope: CatalogScope) {
    return (await catalog.snapshot(scope)).entries.filter(
      (entry): entry is CatalogFileEntry => entry.kind === "file",
    );
  }
  return {
    async resolve(input) {
      const { target } = input;
      if (target.kind === "wikilink") {
        const name = target.name.trim().toLowerCase();
        if (!name || /[\r\n[\]|]/.test(name)) return null;
        const current = await currentScope(input);
        if (!current) return null;
        const scopes: CatalogScope[] = [
          { kind: "project", projectId: input.projectId },
          { kind: "user", userId: input.userId },
          current,
        ];
        const candidates = (await Promise.all(scopes.map(files))).flat();
        return unique(
          candidates.filter((file) =>
            [file.name, documentTitleFromUri(file.uri), ...file.aliases].some(
              (alias) => alias?.trim().toLowerCase() === name,
            ),
          ),
        );
      }
      const base = await location(input, target.kind === "scheme" ? target.uri : target.baseUri);
      if (!base) return null;
      const path = target.kind === "relative" ? relativePath(base.path, target.path) : base.path;
      if (!path) return null;
      return unique(
        (await files(base.scope)).filter((file) => {
          const parsed = parseContextUri(file.uri);
          return (
            parsed.ok && parsed.value.scheme === base.scheme && pathMatches(parsed.value.path, path)
          );
        }),
      );
    },
  };
}

function unique(files: readonly CatalogFileEntry[]): ResolvedDocumentLink | null {
  if (files.length !== 1) return null;
  const file = files[0];
  if (!file) return null;
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

function pathMatches(candidate: string, requested: string): boolean {
  return (
    candidate === requested ||
    (candidate.lastIndexOf(".") > candidate.lastIndexOf("/") &&
      candidate.slice(0, candidate.lastIndexOf(".")) === requested)
  );
}

function relativePath(base: string, relative: string): string | null {
  if (!relative || relative.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(relative)) return null;
  const segments = base.split("/");
  segments.pop();
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!segments.length) return null;
      segments.pop();
    } else segments.push(part);
  }
  return segments.length ? segments.join("/") : null;
}
