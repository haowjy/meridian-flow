import { splitDocumentFile } from "@meridian/agent-edit/integration";
import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import { isProjectScopedScheme, parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { DocumentId, ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import type { ThreadContextResolution } from "../domains/context/context-port-resolution.js";
import type { FileTarget } from "../domains/file-policy/index.js";
import type { WorkRepository } from "../domains/projects/index.js";

export function documentTarget(documentId: string): FileTarget {
  return { kind: "document", documentId: documentId as DocumentId };
}

export async function containerTarget(
  works: Pick<WorkRepository, "findNoWork">,
  input: {
    projectId: string;
    userId: string;
    scheme: ContextUriScheme;
    workId: string | null;
    chatId?: string | null;
  },
): Promise<FileTarget> {
  if (input.scheme === "uploads" && input.chatId) {
    return {
      kind: "container",
      scheme: input.scheme,
      owner: {
        scope: "chat",
        projectId: input.projectId as ProjectId,
        threadId: input.chatId as ThreadId,
      },
    };
  }
  if (input.scheme === "user")
    return {
      kind: "container",
      scheme: input.scheme,
      owner: { scope: "account", userId: input.userId as UserId },
    };
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

export async function threadContainerTarget(
  resolution: Pick<
    ThreadContextResolution,
    | "thread"
    | "primaryWorkId"
    | "workAuthorities"
    | "scratchOwner"
    | "scratchLineages"
    | "uploadsOwner"
    | "uploadChats"
  >,
  path: string,
): Promise<FileTarget | null> {
  const parsed = parseUnifiedContextUri(splitDocumentFile(path).filePath);
  if (!parsed.ok) return null;
  const { scheme, authority } = parsed.value;
  const { thread, primaryWorkId, workAuthorities } = resolution;
  if (scheme === "user")
    return {
      kind: "container",
      scheme,
      owner: { scope: "account", userId: thread.userId as UserId },
    };
  if (isProjectScopedScheme(scheme)) {
    return {
      kind: "container",
      scheme,
      owner: { scope: "project", projectId: thread.projectId as ProjectId },
    };
  }
  if (scheme === "uploads") {
    const chat =
      authority.kind === "chat"
        ? await resolution.uploadChats?.byRef(thread.projectId, authority.chatRef)
        : authority.kind === "contextual"
          ? resolution.uploadsOwner
          : null;
    return chat
      ? {
          kind: "container",
          scheme,
          owner: {
            scope: "chat",
            projectId: thread.projectId as ProjectId,
            threadId: chat.chatId as ThreadId,
          },
        }
      : null;
  }
  if (scheme === "scratch" && authority.kind === "lineage") {
    const lineage = await resolution.scratchLineages?.byRef(
      thread.projectId,
      authority.rootThreadRef,
    );
    return lineage
      ? {
          kind: "container",
          scheme,
          owner: {
            scope: "lineage",
            projectId: thread.projectId,
            rootThreadId: lineage.rootThreadId,
          },
        }
      : null;
  }
  if (
    scheme === "scratch" &&
    authority.kind === "contextual" &&
    resolution.scratchOwner?.scope === "lineage"
  ) {
    return { kind: "container", scheme, owner: resolution.scratchOwner };
  }
  const workId =
    authority.kind === "work"
      ? workAuthorities.get(authority.workHandle as never)?.workId
      : primaryWorkId;
  return workId
    ? { kind: "container", scheme, owner: { scope: "work", workId: workId as WorkId } }
    : null;
}
