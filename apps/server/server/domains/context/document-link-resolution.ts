/** Pure resolution policy shared by persisted and in-memory document-link adapters. */

import { isUuid } from "../../shared/uuid.js";
import type {
  ResolveDocumentLinkInput,
  ResolvedDocumentLink,
} from "./ports/document-link-resolver.js";

export interface DocumentLinkCandidate {
  projectId: string;
  documentId: string;
  title: string;
  aliases?: readonly string[];
  scheme: "manuscript" | "work";
  path: string;
  workId: string | null;
}

export function resolveDocumentLink(
  candidates: readonly DocumentLinkCandidate[],
  input: ResolveDocumentLinkInput,
): ResolvedDocumentLink | null {
  const inProject = candidates.filter((candidate) => candidate.projectId === input.projectId);
  const matches = matchCandidates(inProject, input);
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (!match) return null;
  return {
    documentId: match.documentId,
    title: match.title,
    scheme: match.scheme,
    path: match.path,
    uri:
      match.scheme === "work"
        ? `work://${match.workId}/${match.path}`
        : `manuscript://${match.path}`,
    workId: match.workId,
  };
}

function matchCandidates(
  candidates: readonly DocumentLinkCandidate[],
  input: ResolveDocumentLinkInput,
): DocumentLinkCandidate[] {
  switch (input.target.kind) {
    case "wikilink": {
      const name = normalizedName(input.target.name);
      if (!name || name.includes("|")) return [];
      return candidates.filter(
        (candidate) =>
          normalizedName(candidate.title) === name ||
          candidate.aliases?.some((alias) => normalizedName(alias) === name),
      );
    }
    case "scheme": {
      const location = parseSchemeLocation(input.target.uri, input.workId ?? null);
      if (!location) return [];
      return candidates.filter(
        (candidate) =>
          candidate.scheme === location.scheme &&
          (location.scheme !== "work" || candidate.workId === location.workId) &&
          pathMatches(candidate.path, location.path),
      );
    }
    case "relative": {
      const base = parseSchemeLocation(input.target.baseUri, input.workId ?? null);
      if (!base) return [];
      const path = resolveRelativePath(base.path, input.target.path);
      if (!path) return [];
      return candidates.filter(
        (candidate) =>
          candidate.scheme === base.scheme &&
          (base.scheme !== "work" || candidate.workId === base.workId) &&
          pathMatches(candidate.path, path),
      );
    }
  }
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase();
}

function pathMatches(candidatePath: string, requestedPath: string): boolean {
  if (candidatePath === requestedPath) return true;
  const finalSlash = candidatePath.lastIndexOf("/");
  const finalDot = candidatePath.lastIndexOf(".");
  return finalDot > finalSlash && candidatePath.slice(0, finalDot) === requestedPath;
}

function parseSchemeLocation(
  uri: string,
  fallbackWorkId: string | null,
): { scheme: "manuscript" | "work"; path: string; workId: string | null } | null {
  if (uri.startsWith("manuscript://")) {
    const path = normalizeAbsolutePath(uri.slice("manuscript://".length));
    return path ? { scheme: "manuscript", path, workId: null } : null;
  }
  if (!uri.startsWith("work://")) return null;

  const body = uri.slice("work://".length).replace(/^\/+/, "");
  const [first, ...rest] = body.split("/");
  const hasAuthority = isUuid(first);
  const workId = hasAuthority ? first : fallbackWorkId;
  const path = normalizeAbsolutePath(hasAuthority ? rest.join("/") : body);
  return workId && path ? { scheme: "work", path, workId } : null;
}

function resolveRelativePath(basePath: string, relativePath: string): string | null {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(relativePath)
  ) {
    return null;
  }
  const segments = basePath.split("/");
  segments.pop();
  for (const segment of relativePath.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

function normalizeAbsolutePath(path: string): string | null {
  const segments: string[] = [];
  for (const segment of path.replace(/^\/+/, "").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}
