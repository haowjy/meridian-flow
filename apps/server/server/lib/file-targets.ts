/**
 * Resolving a request to the file it's about (file-access §1, step 1): a
 * document id, or the container a path creates in.
 */

import { splitDocumentFile } from "@meridian/agent-edit/integration";
import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import { isProjectScopedScheme, parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import type { ThreadContextResolution } from "../domains/context/context-port-resolution.js";
import type { FileTarget } from "../domains/file-policy/index.js";
import type { WorkRepository } from "../domains/projects/index.js";

export function documentTarget(documentId: string): FileTarget {
  return { kind: "document", documentId: documentId as DocumentId };
}

/**
 * The container a project route's scheme names: the project's for a
 * project-scoped source, else the named Work's, or No Work's when none is.
 */
export async function containerTarget(
  works: Pick<WorkRepository, "findNoWork">,
  input: { projectId: string; scheme: ContextUriScheme; workId: string | null },
): Promise<FileTarget> {
  if (isProjectScopedScheme(input.scheme)) {
    return {
      kind: "container",
      scheme: input.scheme,
      owner: { scope: "project", projectId: input.projectId as ProjectId },
    };
  }
  const workId = input.workId ?? (await works.findNoWork(input.projectId))?.id;
  if (!workId) throw createError({ statusCode: 404, message: "Work not found" });
  return {
    kind: "container",
    scheme: input.scheme,
    owner: { scope: "work", workId: workId as WorkId },
  };
}

/**
 * The container a thread-addressed path makes its file in: the project's for
 * a project-scoped source, else the Work its authority names (the thread's
 * own when it names none). Null when the path names no Work.
 */
export async function threadContainerTarget(
  works: Pick<WorkRepository, "findNoWork">,
  resolution: Pick<ThreadContextResolution, "thread" | "primaryWorkId" | "workAuthorities">,
  path: string,
): Promise<FileTarget | null> {
  const parsed = parseUnifiedContextUri(splitDocumentFile(path).filePath);
  if (!parsed.ok) return null;
  const { scheme, authority } = parsed.value;
  const { thread, primaryWorkId, workAuthorities } = resolution;
  if (isProjectScopedScheme(scheme)) {
    return {
      kind: "container",
      scheme,
      owner: { scope: "project", projectId: thread.projectId as ProjectId },
    };
  }
  const workId =
    authority.kind === "work"
      ? workAuthorities.get(authority.workSlug as never)?.workId
      : authority.kind === "none"
        ? (await works.findNoWork(thread.projectId))?.id
        : primaryWorkId;
  return workId
    ? { kind: "container", scheme, owner: { scope: "work", workId: workId as WorkId } }
    : null;
}
