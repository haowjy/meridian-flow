import type { DraftOwner } from "@meridian/contracts";
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
  type ResolvedDocumentHref,
  resolveStoredLinkAddress,
} from "@meridian/contracts";
import type { DocumentId, ProjectId, UserId, WorkId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import type { DocumentLinkScopes, Drafts } from "../domains/collab/index.js";
import type { DocumentLinkResolver } from "../domains/context/index.js";
import type { DocumentTrash } from "../domains/context/ports/document-trash.js";
import type { UploadIdentityPort } from "../domains/context/uploads/index.js";
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
  drafts: Pick<Drafts, "viewForOwner">;
  documentTrash: Pick<DocumentTrash, "retained">;
  files: Pick<UploadIdentityPort, "lookupDocuments">;
}

type DocumentAnswer = Extract<DocumentLinkAnswer, { state: "document" }>["document"];

export async function handleDocumentLinkResolveRequest(
  deps: DocumentLinkRouteDeps,
  input: { projectId: string; userId: UserId; request: ResolveDocumentLinksRequest },
): Promise<ResolveDocumentLinksResponse> {
  const { projectId, userId, request } = input;
  await requireProjectOwner({ projects: deps.projectRepo }, projectId, userId);
  const workId = request.rootThreadId ? null : (request.workId ?? null);
  if (
    workId &&
    !(await deps.workAuthorityResolver.byId(projectId as ProjectId, workId as WorkId))
  ) {
    throwContextWorkUnavailableHttpError("work_missing");
  }
  const owner: DraftOwner | null = request.rootThreadId
    ? { kind: "lineage", projectId: projectId as ProjectId, rootThreadId: request.rootThreadId }
    : workId
      ? { kind: "work", workId: workId as WorkId }
      : null;
  const view: LinkView = await deps.drafts.viewForOwner(owner);
  const answers: DocumentLinkAnswer[] = new Array(request.links.length);
  let holderUri: string | undefined;
  const refResolutions: Array<{
    index: number;
    resolution: LinkResolution;
    candidateId?: DocumentId;
  }> = [];
  let baseUri = request.baseUri;
  let linkAddresses: Array<ResolvedDocumentHref | null> = [];

  // keep: a ref is not a capability: the scope answers readability for this account
  await deps.linkScopes.within(
    {
      projectId,
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
      linkAddresses = request.links.map((link) => resolveStoredLinkAddress(link, baseUri));
      const scopedLinks = request.links.flatMap((link, index) => {
        const address = linkAddresses[index] ?? null;
        return link.ref !== null || address?.kind === "folder" ? [{ link, index, address }] : [];
      });
      if (scopedLinks.length === 0) return;
      await deps.linkScopes.prepare({
        holders: holder ? [{ documentId: holder.documentId, view }] : [],
        views: [view],
        refs: scopedLinks.flatMap(({ link }) => (link.ref === null ? [] : [link.ref])),
        addresses: scopedLinks.flatMap(({ link, address }) =>
          parseLinkRef(link.ref)?.kind === "ahead" && address?.kind === "document"
            ? [address.uri]
            : [],
        ),
        folderAddresses: scopedLinks.flatMap(({ address }) =>
          address?.kind === "folder" ? [address.uri] : [],
        ),
      });
      const reader = holder
        ? deps.linkScopes.holder({ documentId: holder.documentId, view })
        : deps.linkScopes.reader({ uri: request.baseUri, view });
      for (const { link, index, address } of scopedLinks) {
        const resolution = reader.resolve(link, address);
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
  const unanswered: Array<{ index: number; uri: string }> = [];
  const byHref = new Map<string, ReturnType<DocumentLinkResolver["resolve"]>>();
  for (const [index, link] of request.links.entries()) {
    if (link.ref !== null || answers[index] !== undefined) continue;
    const target = linkAddresses[index];
    if (target?.kind !== "document") {
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
        uri: target.uri,
        previousLocations: baseUri === null && request.holderDocumentId === undefined,
      });
      byHref.set(link.href, resolving);
    }
    const resolved = await resolving;
    if (!resolved) unanswered.push({ index, uri: target.uri });
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
  if (unanswered.length > 0) {
    await answerFromDraftView(deps, { projectId, userId, view, unanswered, answers });
  }
  await addFileFacts(deps.files, answers);
  return holderUri === undefined ? { answers } : { answers, holderUri };
}

async function addFileFacts(
  files: DocumentLinkRouteDeps["files"],
  answers: readonly DocumentLinkAnswer[],
): Promise<void> {
  const named = answers.flatMap((answer) => (answer.state === "document" ? [answer.document] : []));
  if (named.length === 0) return;
  const identities = new Map(
    (await files.lookupDocuments([...new Set(named.map((document) => document.id))])).map(
      (identity) => [identity.documentId, identity],
    ),
  );
  for (const document of named) {
    const identity = identities.get(document.id);
    if (identity?.storageUrl)
      document.file = {
        fileType: identity.fileType,
        mimeType: identity.mimeType,
        sizeBytes: identity.sizeBytes,
      };
  }
}

async function answerFromDraftView(
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
  if (view.kind !== "draft") return;
  await deps.linkScopes.within({ projectId, viewer: { accountId: userId } }, async () => {
    await deps.linkScopes.prepare({
      holders: [],
      views: [view],
      addresses: unanswered.map(({ uri }) => uri),
    });
    for (const { index, uri } of unanswered) {
      const document = deps.linkScopes.draftCreatedAt({ view, uri });
      if (!document) continue;
      answers[index] = answerOf({ kind: "document", document, inDraft: true });
    }
  });
}

function answerOf(resolution: LinkResolution, trashedDocumentId?: string): DocumentLinkAnswer {
  const marks: AheadMarks = "settled" in resolution ? { settled: true as const } : {};
  if (resolution.kind === "document") {
    const { document, inDraft } = resolution;
    const described = describeDocument(document);
    return described
      ? {
          state: "document",
          document: described,
          inDraft,
          ...(document.draft ? { draft: document.draft } : {}),
          ...marks,
        }
      : { state: "gone", ...marks };
  }
  if (resolution.kind === "folder") {
    const parsed = parseContextUri(resolution.folder.uri);
    if (!parsed.ok) return { state: "gone" };
    return {
      state: "folder",
      folder: {
        id: resolution.folder.folderId,
        name: parsed.value.path.split("/").at(-1) ?? parsed.value.path,
        uri: resolution.folder.uri,
      },
    };
  }
  if (resolution.kind === "ahead") return { state: "missing", uri: resolution.uri, ...marks };
  return { state: "gone", ...(trashedDocumentId ? { trashedDocumentId } : {}), ...marks };
}

type AheadMarks = { settled?: true };

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
