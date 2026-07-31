/** Route core and input validation for project document-link resolution. */

import type { UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import type { DocumentLinkResolver, DocumentLinkTarget } from "../domains/context/index.js";
import { requireProjectOwner } from "../domains/projects/index.js";
import type { ProjectRepository } from "../domains/projects/ports/project-repository.js";
import { parseRequestId } from "../shared/uuid.js";

const MAX_LINK_TARGET_LENGTH = 2_048;

export interface DocumentLinkRouteDeps {
  projectRepo: ProjectRepository;
  documentLinks: DocumentLinkResolver;
}

export async function handleDocumentLinkResolveRequest(
  deps: DocumentLinkRouteDeps,
  input: {
    projectId: string;
    userId: UserId;
    workId?: string | null;
    target: DocumentLinkTarget;
  },
) {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  return {
    document: await deps.documentLinks.resolve({
      projectId: input.projectId,
      workId: input.workId,
      target: input.target,
    }),
  };
}

export function parseDocumentLinkResolveBody(body: unknown): {
  workId?: string | null;
  target: DocumentLinkTarget;
} {
  const record = asRecord(body);
  const target = asRecord(record?.target);
  const kind = target?.kind;
  const workId = record?.workId;
  if (workId !== undefined && workId !== null && typeof workId !== "string") invalidBody();
  const parsedWorkId = typeof workId === "string" ? parseRequestId(workId) : workId;
  if (typeof workId === "string" && !parsedWorkId) invalidBody();

  switch (kind) {
    case "wikilink":
      if (!validTargetPart(target?.name)) invalidBody();
      return { workId: parsedWorkId, target: { kind, name: target.name } };
    case "scheme":
      if (!validTargetPart(target?.uri)) invalidBody();
      return { workId: parsedWorkId, target: { kind, uri: target.uri } };
    case "relative":
      if (!validTargetPart(target?.path) || !validTargetPart(target?.baseUri)) invalidBody();
      return {
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
