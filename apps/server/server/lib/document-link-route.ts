/**
 * Route core for batched stored-link resolution (contract §13): ref links through the
 * reader's prepared link scope, ref-less links through the address resolver.
 *
 * The route pins the holder (by `holderDocumentId` wherever that document now sits, else
 * by the one document at `baseUri`, and only one the reader may name and read) so its
 * relative links spell from where it is now.
 */

import {
  type CatalogDocument,
  type DocumentLinkAnswer,
  documentTitleFromUri,
  type LinkResolution,
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
import type { Branches, DocumentLinkScopes } from "../domains/collab/index.js";
import type { DocumentLinkResolver, DocumentLinkTarget } from "../domains/context/index.js";
import type { DocumentTrash } from "../domains/context/ports/document-trash.js";
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
  /** The selected Work's view: its active branch, or live when it has none (F7). */
  branches: Pick<Branches, "viewForWork">;
  /** Project-authorized retained identities for gone links; purged rows are absent. */
  documentTrash: Pick<DocumentTrash, "retained">;
}

type DocumentAnswer = Extract<DocumentLinkAnswer, { state: "document" }>["document"];

export async function handleDocumentLinkResolveRequest(
  deps: DocumentLinkRouteDeps,
  input: { projectId: string; userId: UserId; request: ResolveDocumentLinksRequest },
): Promise<ResolveDocumentLinksResponse> {
  const { projectId, userId, request } = input;
  await requireProjectOwner({ projects: deps.projectRepo }, projectId, userId);
  // Lineage is Scratch's owner, not a replacement for the chat's No Work
  // branch view: project-document refs still read in that Work's branch view.
  const workId = request.rootThreadId
    ? ((await deps.workAuthorityResolver.noWork(projectId as ProjectId))?.workId ?? null)
    : (request.workId ?? null);
  // The selected Work must be this project's; a branch view is never provisioned for any other.
  if (
    workId &&
    !(await deps.workAuthorityResolver.byId(projectId as ProjectId, workId as WorkId))
  ) {
    throwContextWorkUnavailableHttpError("work_missing");
  }
  // A Work's branch view is the live tree plus what that branch created.
  const view: LinkView = workId
    ? await deps.branches.viewForWork(workId as WorkId)
    : { kind: "live" };
  const answers: DocumentLinkAnswer[] = new Array(request.links.length);
  let holderUri: string | undefined;
  const refResolutions: Array<{
    index: number;
    resolution: LinkResolution;
    candidateId?: DocumentId;
  }> = [];
  // Relative hrefs resolve against the holder where it is now.
  let baseUri = request.baseUri;

  // A ref is not a capability: the scope answers readability for this account.
  await deps.linkScopes.within(
    {
      projectId,
      // Scratch ownership does not select a reader thread or its primary Work.
      viewer: { accountId: userId },
    },
    async () => {
      const holderNamed = request.holderDocumentId !== undefined || request.baseUri !== null;
      const holder = holderNamed
        ? await deps.linkScopes.pinHolder({
            view,
            ...(request.holderDocumentId !== undefined
              ? { documentId: request.holderDocumentId }
              : {}),
            uri: request.baseUri,
          })
        : null;
      if (holder) {
        baseUri = holder.uri;
        if (holder.uri !== request.baseUri) holderUri = holder.uri;
      }
      const refLinks = request.links.flatMap((link, index) =>
        link.ref === null ? [] : [{ link, index }],
      );
      if (refLinks.length === 0) return;
      await deps.linkScopes.prepare({
        holders: holder ? [{ documentId: holder.documentId, view }] : [],
        views: [view],
        refs: refLinks.map(({ link }) => link.ref as string),
        // An unsettled ahead ref resolves by its exact stored address.
        addresses: refLinks.flatMap(({ link }) =>
          parseLinkRef(link.ref)?.kind === "ahead"
            ? (resolveDocumentHref(link.href, null)?.uri ?? [])
            : [],
        ),
      });
      const reader = holder
        ? deps.linkScopes.holder({ documentId: holder.documentId, view })
        : deps.linkScopes.reader({ uri: request.baseUri, view });
      for (const { link, index } of refLinks) {
        const resolution = reader.resolve(link);
        const parsed = parseLinkRef(link.ref);
        const candidateId =
          resolution.kind === "gone"
            ? (resolution.documentId ?? (parsed?.kind === "doc" ? parsed.documentId : undefined))
            : undefined;
        refResolutions.push({
          index,
          resolution,
          ...(candidateId ? { candidateId: candidateId as DocumentId } : {}),
        });
      }
    },
  );
  const retainedIds = await deps.documentTrash.retained(
    projectId as ProjectId,
    refResolutions.flatMap(({ candidateId }) => (candidateId ? [candidateId] : [])),
  );
  for (const { index, resolution, candidateId } of refResolutions) {
    answers[index] = answerOf(
      resolution,
      candidateId && retainedIds.has(candidateId) ? candidateId : undefined,
    );
  }

  const found: Array<{ index: number; document: DocumentAnswer }> = [];
  // Address-only links the live tree left unanswered: a Work's branch may have created them.
  const unanswered: Array<{ index: number; uri: string }> = [];
  const byHref = new Map<string, ReturnType<DocumentLinkResolver["resolve"]>>();
  for (const [index, link] of request.links.entries()) {
    if (link.ref !== null) continue;
    const target = addressTarget(link.href, baseUri);
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
        chatId: request.chatId,
        target: target.target,
        // Chat alone may follow a vacated path to the document that left it.
        previousLocations: baseUri === null && request.holderDocumentId === undefined,
      });
      byHref.set(link.href, resolving);
    }
    const resolved = await resolving;
    if (!resolved) {
      unanswered.push({ index, uri: target.uri });
    }
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
          chatThreadId: resolved.chatThreadId,
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
        answers[index] = { state: "document", document, inBranch: false };
      }
    }
  }
  if (unanswered.length > 0) {
    await answerFromBranchView(deps, { projectId, userId, view, unanswered, answers });
  }
  return holderUri === undefined ? { answers } : { answers, holderUri };
}

/**
 * Names the document a Work's branch created at an address the live tree leaves empty (the
 * scope's `branchCreatedAt`: exact, then the one extension-omitted match). A live occupant
 * keeps winning, since these never reached one; another branch's creation and what the
 * reader may not read stay missing.
 */
async function answerFromBranchView(
  deps: DocumentLinkRouteDeps,
  input: {
    projectId: string;
    userId: UserId;
    view: LinkView;
    unanswered: ReadonlyArray<{ index: number; uri: string }>;
    answers: DocumentLinkAnswer[];
  },
): Promise<void> {
  const { projectId, userId, view, unanswered, answers } = input;
  if (view.kind !== "branch") return;
  await deps.linkScopes.within({ projectId, viewer: { accountId: userId } }, async () => {
    await deps.linkScopes.prepare({
      holders: [],
      views: [view],
      addresses: unanswered.map(({ uri }) => uri),
    });
    for (const { index, uri } of unanswered) {
      const document = deps.linkScopes.branchCreatedAt({ view, uri });
      if (!document) continue;
      answers[index] = answerOf({ kind: "document", document, inBranch: true });
    }
  });
}

/** One reader resolution as the transport answer. */
function answerOf(resolution: LinkResolution, trashedDocumentId?: string): DocumentLinkAnswer {
  // Rule 3: the client keeps the settlement and never answers this ref by address again.
  const marks: AheadMarks = "settled" in resolution ? { settled: true as const } : {};
  if (resolution.kind === "document") {
    const { document, inBranch } = resolution;
    const described = describeDocument(document);
    return described
      ? {
          state: "document",
          document: described,
          inBranch,
          ...(document.branch ? { branch: document.branch } : {}),
          ...marks,
        }
      : { state: "gone", ...marks };
  }
  if (resolution.kind === "ahead") return { state: "missing", uri: resolution.uri, ...marks };
  // gone, and a snapshot miss: never a location the reader was not shown.
  return { state: "gone", ...(trashedDocumentId ? { trashedDocumentId } : {}), ...marks };
}

/** What an answer says about how a ref was read: settled, or without its holder's bindings. */
type AheadMarks = { settled?: true };

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

/** Flatten the prepared document's resolved owner at the transport boundary. */
function describeDocument(document: CatalogDocument): DocumentAnswer | null {
  const parsed = parseContextUri(document.uri);
  if (!parsed.ok) return null;
  const { scheme, path } = parsed.value;
  return {
    id: document.documentId,
    workId: document.owner.workId ?? null,
    ...(document.owner.rootThreadId ? { rootThreadId: document.owner.rootThreadId } : {}),
    ...(document.owner.chatThreadId ? { chatThreadId: document.owner.chatThreadId } : {}),
    title: documentTitleFromUri(document.uri) ?? path,
    scheme,
    path,
    uri: document.uri,
  };
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
