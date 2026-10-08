import type { RestoreAgentDeleteResponse } from "@meridian/contracts/protocol";
import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import type { NamespaceChanges, NamespaceTree } from "../domains/collab/index.js";
import {
  contextPortForThread,
  resolveThreadContext,
} from "../domains/context/context-port-resolution.js";
import type { ContextError } from "../domains/context/ports/context-port.js";
import type { UnifiedContextPortFactory } from "../domains/context/unified-context-port-factory.js";
import {
  type FileAccess,
  type FileTarget,
  isFileAccessDenied,
  runWithEditGrants,
} from "../domains/file-policy/index.js";
import type { ProjectWorkAuthorityResolver, WorkRepository } from "../domains/projects/index.js";
import type { ThreadRepository, ThreadWorksRepository } from "../domains/threads/index.js";
import { Err, type Result } from "../shared/result.js";
import { contextErrorToHttp } from "./context-error-http.js";
import { requireFileGrant, withEditGrants } from "./file-access-http.js";
import { documentTarget, threadContainerTarget } from "./file-targets.js";
import { namespaceTree } from "./namespace-tree.js";
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

/**
 * The thread's live tree for the writer's undo of the agent's creates, moves
 * and deletes: each change needs the writer's edit on the document and on the
 * folder it lands in.
 */
export async function writerNamespaceTree(
  deps: ThreadContextRouteDeps,
  threadId: ThreadId,
  userId: UserId,
): Promise<NamespaceTree<ContextError>> {
  const { resolution } = await resolveThreadContextPort(deps, threadId, userId);
  return writerTree(
    deps,
    resolution,
    userId,
    namespaceTree(contextPortForThread(deps.contextPorts, resolution, { liveWrites: true })),
  );
}

function writerTree(
  deps: ThreadContextRouteDeps,
  resolution: Awaited<ReturnType<typeof resolveThreadContextPort>>["resolution"],
  userId: UserId,
  tree: NamespaceTree<ContextError>,
): NamespaceTree<ContextError> {
  /** Edit on the folder `uri` is in and, while it's there, on the document. */
  const granted = async (
    uri: string,
    documentId: string | null,
    operation: () => Promise<Result<unknown, ContextError>>,
  ): Promise<Result<unknown, ContextError>> => {
    const folder = await threadContainerTarget(deps.works, resolution, uri);
    const targets = [
      ...(folder ? [folder] : []),
      ...(documentId ? [documentTarget(documentId)] : []),
    ];
    const grants = [];
    for (const target of targets) {
      const grant = await deps.fileAccess.authorize({ accountId: userId }, target, "edit");
      if (isFileAccessDenied(grant)) return Err({ code: "permission_denied", uri });
      grants.push(grant);
    }
    const run = await runWithEditGrants(deps.fileAccess, grants, operation);
    return run.ok ? run.value : Err({ code: "permission_denied", uri });
  };
  return {
    move: (from, to, documentId) => granted(to, documentId, () => tree.move(from, to, documentId)),
    delete: (uri, documentId) => granted(uri, documentId, () => tree.delete(uri, documentId)),
    // A deleted document has no grant to take; its folder's edit brings it back.
    restore: (uri, documentId) => granted(uri, null, () => tree.restore(uri, documentId)),
    settleLinks: async (uris) => writerTree(deps, resolution, userId, await tree.settleLinks(uris)),
    lock: (uris) => tree.lock(uris),
  };
}

/**
 * The writer brings back a document the agent deleted live in this turn, from
 * the turn's delete receipt (D66): the delete's undo, as the model's `undo`
 * makes it, so the model's `redo` may delete the document again.
 */
export async function restoreAgentDelete(
  deps: ThreadContextRouteDeps & { namespaceChanges: NamespaceChanges },
  input: { threadId: ThreadId; turnId: string; documentId: string; userId: UserId },
): Promise<RestoreAgentDeleteResponse> {
  const threadId = requireRequestId(input.threadId, "threadId") as ThreadId;
  const turnId = requireRequestId(input.turnId, "turnId");
  const documentId = requireRequestId(input.documentId, "documentId");
  const tree = await writerNamespaceTree(deps, threadId, input.userId);
  const change = await deps.namespaceChanges.findTurnDelete(threadId, turnId, documentId);
  if (change?.status !== "active") {
    return change?.status === "reversed" && change.documentLive
      ? { status: "already_restored", documentId, uri: change.fromUri }
      : { status: "nothing_to_restore" };
  }
  const restored = await deps.namespaceChanges.reverse(tree, change, "undo");
  if (restored.ok) return { status: "restored", documentId, uri: change.fromUri };
  switch (restored.error.code) {
    case "claimed": {
      const current = await deps.namespaceChanges.findTurnDelete(threadId, turnId, documentId);
      return current?.status === "reversed" && current.documentLive
        ? { status: "already_restored", documentId, uri: current.fromUri }
        : { status: "nothing_to_restore" };
    }
    case "conflict":
      return { status: "location_taken", uri: change.fromUri };
    case "not_found":
      return { status: "folder_missing", uri: change.fromUri };
    default:
      return contextErrorToHttp(restored.error);
  }
}
