import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import {
  contextPortForThread,
  resolveThreadContext,
} from "../domains/context/context-port-resolution.js";
import type { UnifiedContextPortFactory } from "../domains/context/unified-context-port-factory.js";
import type { FileAccess, FileTarget } from "../domains/file-policy/index.js";
import type { ProjectWorkAuthorityResolver, WorkRepository } from "../domains/projects/index.js";
import type { ThreadRepository, ThreadWorksRepository } from "../domains/threads/index.js";
import { contextErrorToHttp } from "./context-error-http.js";
import { requireFileGrant, withEditGrants } from "./file-access-http.js";
import { documentTarget, threadContainerTarget } from "./file-targets.js";
import { requireRequestId } from "./request-id.js";

export interface ThreadContextRouteDeps {
  contextPorts: UnifiedContextPortFactory;
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary">;
  works: Pick<WorkRepository, "listByProject" | "findNoWork" | "findById">;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
}

export async function resolveThreadContextPort(
  deps: ThreadContextRouteDeps,
  threadId: ThreadId,
  userId: UserId,
) {
  const resolution = await resolveThreadContext(deps, threadId);
  if (!resolution || resolution.thread.userId !== userId) {
    throw createError({ statusCode: 404, message: "Thread not found" });
  }
  return { resolution, port: contextPortForThread(deps.contextPorts, resolution) };
}

/**
 * What a thread-addressed URI is, for the writer's grant: the document it
 * names, or the container a write would create it in.
 */
async function uriTarget(
  deps: ThreadContextRouteDeps,
  context: Awaited<ReturnType<typeof resolveThreadContextPort>>,
  uri: string,
): Promise<FileTarget> {
  const ref = await context.port.stat(uri);
  if (ref.ok && ref.value.documentId) return documentTarget(ref.value.documentId);
  if (ref.ok || ref.error.code === "not_found") {
    const container = await threadContainerTarget(deps.works, context.resolution, uri);
    if (container) return container;
  }
  if (!ref.ok) contextErrorToHttp(ref.error);
  throw createError({ statusCode: 404, message: "Document not found" });
}

export async function readThreadContextDocument(
  deps: ThreadContextRouteDeps,
  input: { threadId: ThreadId; userId: UserId; uri: string },
) {
  const threadId = requireRequestId(input.threadId, "threadId") as ThreadId;
  const context = await resolveThreadContextPort(deps, threadId, input.userId);
  const ref = await context.port.stat(input.uri);
  if (!ref.ok) contextErrorToHttp(ref.error);
  if (ref.value.documentId) {
    await requireFileGrant(
      deps.fileAccess,
      input.userId,
      documentTarget(ref.value.documentId),
      "read",
    );
  }
  const result = await context.port.read(input.uri);
  if (!result.ok) contextErrorToHttp(result.error);
  return {
    documentId: result.value.documentId,
    uri: result.value.uri,
    markdown: result.value.content,
  };
}

export async function writeThreadContextDocument(
  deps: ThreadContextRouteDeps,
  input: { threadId: ThreadId; userId: UserId; uri: string; markdown: string },
) {
  const threadId = requireRequestId(input.threadId, "threadId") as ThreadId;
  const context = await resolveThreadContextPort(deps, threadId, input.userId);
  const grant = await requireFileGrant(
    deps.fileAccess,
    input.userId,
    await uriTarget(deps, context, input.uri),
    "edit",
  );
  const result = await withEditGrants(deps.fileAccess, [grant], () =>
    context.port.write(input.uri, input.markdown, {
      origin: { type: "human", userId: input.userId, threadId },
    }),
  );
  if (!result.ok) contextErrorToHttp(result.error);
  return {
    documentId: result.value.documentId,
    uri: result.value.uri,
    markdown: result.value.markdown ?? input.markdown,
    updateSeq: result.value.updateSeq ?? 0,
  };
}
