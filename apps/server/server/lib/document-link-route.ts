/**
 * Route core for batched stored-link resolution (contract §13): ref links through the
 * reader's prepared link scope, ref-less links through the address resolver.
 */

import {
  type CatalogDocument,
  type DocumentLinkAnswer,
  documentTitleFromUri,
  type LinkView,
  parseContextUri,
  parseLinkRef,
  type ResolveDocumentLinksRequest,
  ResolveDocumentLinksRequestSchema,
  type ResolveDocumentLinksResponse,
  resolveDocumentHref,
} from "@meridian/contracts";
import type { DocumentId, ProjectId, UserId, WorkId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import type { DocumentLinkScopes } from "../domains/collab/index.js";
import type { DocumentLinkResolver, DocumentLinkTarget } from "../domains/context/index.js";
import type { FileAccess } from "../domains/file-policy/index.js";
import type { ProjectWorkAuthorityResolver } from "../domains/projects/domain/work-authority.js";
import { requireProjectOwner } from "../domains/projects/index.js";
import type { ProjectRepository } from "../domains/projects/ports/project-repository.js";
import { throwContextWorkUnavailableHttpError } from "./context-error-http.js";

export interface DocumentLinkRouteDeps {
  projectRepo: ProjectRepository;
  documentLinks: DocumentLinkResolver;
  linkScopes: DocumentLinkScopes;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
  fileAccess: Pick<FileAccess, "listAccess">;
}

type DocumentAnswer = Extract<DocumentLinkAnswer, { state: "document" }>["document"];

export async function handleDocumentLinkResolveRequest(
  deps: DocumentLinkRouteDeps,
  input: { projectId: string; userId: UserId; request: ResolveDocumentLinksRequest },
): Promise<ResolveDocumentLinksResponse> {
  const { projectId, userId, request } = input;
  await requireProjectOwner({ projects: deps.projectRepo }, projectId, userId);
  // Lineage is Scratch's owner, not a replacement for the chat's No Work
  // draft view. Project-document refs still read that Work's manifest.
  const workId = request.rootThreadId
    ? ((await deps.workAuthorityResolver.noWork(projectId as ProjectId))?.workId ?? null)
    : (request.workId ?? null);
  // The selected Work must be this project's; a draft view is never provisioned for any other.
  if (
    workId &&
    !(await deps.workAuthorityResolver.byId(projectId as ProjectId, workId as WorkId))
  ) {
    throwContextWorkUnavailableHttpError("work_missing");
  }
  // A Work's draft view is the live tree plus what that draft created.
  const view: LinkView = workId ? { kind: "draft", workId } : { kind: "live" };
  const answers: DocumentLinkAnswer[] = new Array(request.links.length);

  // A ref is not a capability: the scope answers readability for this account.
  await deps.linkScopes.within(
    {
      projectId,
      // Scratch ownership does not select a reader thread or its primary Work.
      viewer: { accountId: userId },
    },
    async () => {
      const refLinks = request.links.flatMap((link, index) =>
        link.ref === null ? [] : [{ link, index }],
      );
      if (refLinks.length === 0) return;
      await deps.linkScopes.prepare({
        holders: [],
        views: [view],
        refs: refLinks.map(({ link }) => link.ref as string),
        // An unsettled ahead ref resolves by its exact stored address.
        addresses: refLinks.flatMap(({ link }) =>
          parseLinkRef(link.ref)?.kind === "ahead"
            ? (resolveDocumentHref(link.href, null)?.uri ?? [])
            : [],
        ),
      });
      const reader = deps.linkScopes.reader({ uri: request.baseUri, view });
      const documents: Array<{
        index: number;
        document: CatalogDocument;
        inDraft: boolean;
        settled: boolean;
      }> = [];
      for (const { link, index } of refLinks) {
        const resolution = reader.resolve(link);
        // Rule 3: the client keeps the settlement and never answers this ref by address again.
        const settled = "settled" in resolution;
        if (resolution.kind === "document") {
          const { document, inDraft } = resolution;
          documents.push({ index, document, inDraft, settled });
        } else if (resolution.kind === "ahead") {
          answers[index] = { state: "missing", uri: resolution.uri };
        } else {
          // gone, and a snapshot miss: never a location the reader was not shown.
          answers[index] = settled ? { state: "gone", settled: true } : { state: "gone" };
        }
      }
      const described = await describeDocuments(
        deps.workAuthorityResolver,
        projectId,
        documents.map(({ document }) => document),
      );
      for (const [position, { index, inDraft, settled }] of documents.entries()) {
        const document = described[position];
        const marked = settled ? { settled: true as const } : {};
        answers[index] = document
          ? { state: "document", document, inDraft, ...marked }
          : { state: "gone", ...marked };
      }
    },
  );

  const found: Array<{ index: number; document: DocumentAnswer }> = [];
  const byHref = new Map<string, ReturnType<DocumentLinkResolver["resolve"]>>();
  for (const [index, link] of request.links.entries()) {
    if (link.ref !== null) continue;
    const target = addressTarget(link.href, request.baseUri);
    if (!target) {
      answers[index] = { state: "unresolvable" };
      continue;
    }
    let resolving = byHref.get(link.href);
    if (!resolving) {
      resolving = deps.documentLinks.resolve({
        projectId,
        userId,
        workId,
        rootThreadId: request.rootThreadId,
        target: target.target,
        // Chat alone may follow a vacated path to the document that left it.
        previousLocations: request.baseUri === null,
      });
      byHref.set(link.href, resolving);
    }
    const resolved = await resolving;
    if (resolved) {
      found.push({
        index,
        document: {
          id: resolved.documentId,
          title: resolved.title,
          scheme: resolved.scheme,
          path: resolved.path,
          uri: resolved.uri,
          workId: resolved.workId,
          rootThreadId: resolved.rootThreadId,
        },
      });
    }
    // An unreadable occupant answers as nothing there, at the address the client sent.
    answers[index] = { state: "missing", uri: target.uri };
  }
  if (found.length > 0) {
    const access = await deps.fileAccess.listAccess(
      { accountId: userId },
      found.map(({ document }) => document.id as DocumentId),
    );
    for (const { index, document } of found) {
      if (access.has(document.id as DocumentId)) {
        answers[index] = { state: "document", document, inDraft: false };
      }
    }
  }
  return { answers };
}

/** The address a ref-less href names, or null for external and malformed hrefs. */
function addressTarget(
  href: string,
  baseUri: string | null,
): { target: DocumentLinkTarget; uri: string } | null {
  const resolved = resolveDocumentHref(href, baseUri);
  if (!resolved) return null;
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(href);
  return {
    uri: resolved.uri,
    target:
      absolute || baseUri === null
        ? { kind: "scheme", uri: href }
        : { kind: "relative", path: href, baseUri },
  };
}

/** Wire shape for resolved documents; the Work id comes from the URI's authority. */
async function describeDocuments(
  works: ProjectWorkAuthorityResolver,
  projectId: string,
  documents: readonly CatalogDocument[],
): Promise<Array<DocumentAnswer | null>> {
  const workIds = new Map<string, Promise<string | null>>();
  const workIdFor = (key: string, lookup: () => Promise<{ workId: string } | null>) => {
    let pending = workIds.get(key);
    if (!pending) {
      pending = lookup().then((work) => work?.workId ?? null);
      workIds.set(key, pending);
    }
    return pending;
  };
  return Promise.all(
    documents.map(async (document) => {
      const parsed = parseContextUri(document.uri);
      if (!parsed.ok) return null;
      const { scheme, path, authority } = parsed.value;
      const workId =
        authority.kind === "none"
          ? await workIdFor("@/", () => works.noWork(projectId as ProjectId))
          : authority.kind === "work"
            ? await workIdFor(authority.workSlug, () =>
                works.bySlug(projectId as ProjectId, authority.workSlug as never),
              )
            : null;
      return {
        id: document.documentId,
        ...(document.rootThreadId ? { rootThreadId: document.rootThreadId } : {}),
        title: documentTitleFromUri(document.uri) ?? path,
        scheme,
        path,
        uri: document.uri,
        workId,
      };
    }),
  );
}

export function parseDocumentLinkResolveBody(body: unknown): ResolveDocumentLinksRequest {
  const parsed = ResolveDocumentLinksRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: "Invalid document link resolution request",
    });
  }
  return parsed.data;
}
