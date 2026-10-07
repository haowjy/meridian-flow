/** Route core and input validation for project document-link resolution. */

import type { ResolveDocumentLinkRequest } from "@meridian/contracts/protocol";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import type { DocumentLinkResolver, DocumentLinkTarget } from "../domains/context/index.js";
import type { FileAccess } from "../domains/file-policy/index.js";
import { requireProjectOwner } from "../domains/projects/index.js";
import type { ProjectRepository } from "../domains/projects/ports/project-repository.js";
import { parseRequestId } from "../shared/uuid.js";

const MAX_LINK_TARGET_LENGTH = 2_048;

export interface DocumentLinkRouteDeps {
  projectRepo: ProjectRepository;
  documentLinks: DocumentLinkResolver;
  fileAccess: Pick<FileAccess, "listAccess">;
}

export async function handleDocumentLinkResolveRequest(
  deps: DocumentLinkRouteDeps,
  input: {
    projectId: string;
    userId: UserId;
    workId?: string | null;
    target: DocumentLinkTarget;
    holder?: ResolveDocumentLinkRequest["holder"];
  },
) {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  const document = await deps.documentLinks.resolve({
    projectId: input.projectId,
    userId: input.userId,
    workId: input.workId,
    target: input.target,
    holder: input.holder,
  });
  if (!document) return { document };
  // A link resolves only to a file the writer can read (file-access §4). This
  // also covers answers found through the holder's pending redirects.
  const access = await deps.fileAccess.listAccess({ accountId: input.userId }, [
    document.documentId as DocumentId,
  ]);
  return { document: access.has(document.documentId as DocumentId) ? document : null };
}

export function parseDocumentLinkResolveBody(body: unknown): ResolveDocumentLinkRequest {
  const record = asRecord(body);
  const target = asRecord(record?.target);
  const kind = target?.kind;
  const rawHolder = record?.holder;
  const holderRecord = asRecord(rawHolder);
  let holder: ResolveDocumentLinkRequest["holder"];
  if (rawHolder !== undefined) {
    if (
      !holderRecord ||
      typeof holderRecord.documentId !== "string" ||
      !parseRequestId(holderRecord.documentId) ||
      !validTargetPart(holderRecord.href)
    )
      invalidBody();
    holder = { documentId: holderRecord.documentId, href: holderRecord.href };
  }
  const workId = record?.workId;
  if (workId !== undefined && workId !== null && typeof workId !== "string") invalidBody();
  const parsedWorkId = typeof workId === "string" ? parseRequestId(workId) : workId;
  if (typeof workId === "string" && !parsedWorkId) invalidBody();

  switch (kind) {
    case "scheme":
      if (!validTargetPart(target?.uri)) invalidBody();
      return {
        ...(holder ? { holder } : {}),
        workId: parsedWorkId,
        target: { kind, uri: target.uri },
      };
    case "relative":
      if (!validTargetPart(target?.path) || !validTargetPart(target?.baseUri)) invalidBody();
      return {
        ...(holder ? { holder } : {}),
        workId: parsedWorkId,
        target: { kind, path: target.path, baseUri: target.baseUri },
      };
    default:
      return invalidBody();
  }
}

function validTargetPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_LINK_TARGET_LENGTH;
}

function invalidBody(): never {
  throw createError({
    statusCode: 400,
    statusMessage: "Invalid document link resolution request",
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
