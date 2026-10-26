/**
 * A create at a writer-chosen destination (a document or a folder) needs more than its route:
 * the destination root's address when the parent is an area root, the container the writer must
 * be able to edit there, and the check on the address the port finally resolves.
 */
import {
  type CanonicalContextAuthority,
  isProjectScopedScheme,
  isWorkScopedScheme,
  parseUnifiedContextUri,
} from "@meridian/contracts/context-uri";
import type { ContextCreateDestination } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import {
  type FileTarget,
  isFileAccessDenied,
} from "../../../../../../domains/file-policy/index.js";
import type { AppServices } from "../../../../../../lib/compose.js";
import { throwContextWorkUnavailableHttpError } from "../../../../../../lib/context-error-http.js";
import { parseDestinationParent } from "../../../../../../lib/context-move-route.js";
import { parseContextMutationName } from "../../../../../../lib/context-mutation-validation.js";
import { toUri } from "./_helpers.js";

export function parseCreateDestination(raw: unknown): ContextCreateDestination {
  if (!raw || typeof raw !== "object") {
    throw createError({ statusCode: 400, message: "`destination` must be an object" });
  }
  const fields = raw as Record<string, unknown>;
  return {
    parent: parseDestinationParent(fields.parent),
    name: parseContextMutationName(fields.name, "destination.name"),
  };
}

/** A canonical address as the container the caller needs edit on, or null when none is named. */
async function containerOfUri(
  app: AppServices,
  projectId: string,
  uri: string,
): Promise<FileTarget | null> {
  const parsed = parseUnifiedContextUri(uri);
  if (!parsed.ok) return null;
  const { scheme, authority } = parsed.value;
  if (isProjectScopedScheme(scheme)) {
    return {
      kind: "container",
      scheme,
      owner: { scope: "project", projectId: projectId as ProjectId },
    };
  }
  if (scheme === "uploads") {
    const chat =
      authority.kind === "chat"
        ? await app.contextPorts.chats.byRef(projectId, authority.chatRef)
        : null;
    return chat
      ? {
          kind: "container",
          scheme,
          owner: {
            scope: "chat",
            projectId: projectId as ProjectId,
            threadId: chat.chatId as ThreadId,
          },
        }
      : null;
  }
  if (authority.kind === "lineage") {
    const lineage = await app.contextPorts.lineages.byRef(projectId, authority.rootThreadRef);
    return lineage
      ? {
          kind: "container",
          scheme,
          owner: { scope: "lineage", projectId, rootThreadId: lineage.rootThreadId },
        }
      : null;
  }
  const work =
    authority.kind === "work"
      ? await app.workAuthorityResolver.byHandle(projectId, authority.workHandle)
      : null;
  return work ? { kind: "container", scheme, owner: { scope: "work", workId: work.workId } } : null;
}

/** The URI of the destination scheme's root for the named owner, for a root-kind parent. */
async function destinationRootUri(
  app: AppServices,
  projectId: string,
  parent: Extract<ContextCreateDestination["parent"], { kind: "root" }>,
): Promise<string> {
  const { scheme, owner } = parent;
  let authority: CanonicalContextAuthority = { kind: "contextual" };
  if (owner.rootThreadId) {
    if (scheme !== "scratch")
      throw createError({ statusCode: 400, message: "Only Scratch belongs to a chat" });
    const lineage = await app.contextPorts.lineages.byId(projectId, owner.rootThreadId);
    if (!lineage) throw createError({ statusCode: 404, message: "Chat not found" });
    authority = { kind: "lineage", rootThreadRef: lineage.rootThreadRef };
  } else if (isWorkScopedScheme(scheme)) {
    if (!owner.workId)
      throw createError({ statusCode: 400, message: "Scratch belongs to a Work or a chat" });
    else {
      const resolved = await app.workAuthorityResolver.byId(projectId, owner.workId);
      if (!resolved) throwContextWorkUnavailableHttpError("work_missing");
      authority = resolved;
    }
  }
  return toUri(scheme, "", authority);
}

/**
 * The access a typed destination adds to a create: its root's address and container for a
 * root-kind parent, and the check the port runs on the resolved address.
 */
export async function createDestinationAccess(input: {
  app: AppServices;
  userId: string;
  projectId: string;
  destination: ContextCreateDestination;
}) {
  const { app, userId, projectId, destination } = input;
  const parent = destination.parent;
  const rootUri =
    parent.kind === "root" ? await destinationRootUri(app, projectId, parent) : undefined;
  const rootContainer =
    rootUri !== undefined ? await containerOfUri(app, projectId, rootUri) : null;
  const authorizeDestination = async (uri: string) => {
    const target = await containerOfUri(app, projectId, uri);
    if (!target) return false;
    const grant = await app.fileAccess.authorize({ accountId: userId as UserId }, target, "edit");
    return !isFileAccessDenied(grant) && (await app.fileAccess.confirmEdit([grant])).length === 0;
  };
  return { rootUri, rootContainer, authorizeDestination };
}
