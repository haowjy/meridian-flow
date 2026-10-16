/**
 * Materializes a client-minted document without seeding its Yjs content. Nameless it is
 * `Untitled N` in the route's folder. With a `destination` (the writer's New file and a
 * link's Create) it lands at the typed name: a draft's hidden document there is unhidden
 * and the answer is `joined`; a visible node there leaves the create at the free name.
 */
import {
  type CanonicalContextAuthority,
  isProjectScopedScheme,
  isWorkScopedScheme,
  parseUnifiedContextUri,
} from "@meridian/contracts/context-uri";
import type {
  CreateUntitledContextDocumentAnswer,
  CreateUntitledDestination,
} from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import type { ContextPort } from "../../../../../../domains/context/index.js";
import {
  type FileTarget,
  isFileAccessDenied,
} from "../../../../../../domains/file-policy/index.js";
import type { AppServices } from "../../../../../../lib/compose.js";
import { throwContextWorkUnavailableHttpError } from "../../../../../../lib/context-error-http.js";
import { parseDestinationParent } from "../../../../../../lib/context-move-route.js";
import {
  parseContextMutationName,
  parseContextMutationPath,
} from "../../../../../../lib/context-mutation-validation.js";
import { containerTarget } from "../../../../../../lib/file-access-http.js";
import { contextErrorToHttp, resolveContextRoute, toUri } from "./_helpers.js";

interface CreateUntitledBody {
  documentId: string;
  folderPath?: string;
  destination?: CreateUntitledDestination;
}

export function parseCreateUntitledBody(raw: unknown): CreateUntitledBody {
  if (!raw || typeof raw !== "object") {
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  }
  const body = raw as Partial<CreateUntitledBody> & { destination?: unknown };
  if (typeof body.documentId !== "string" || body.documentId.trim() === "") {
    throw createError({ statusCode: 400, message: "`documentId` is required" });
  }
  if (body.folderPath !== undefined && typeof body.folderPath !== "string") {
    throw createError({ statusCode: 400, message: "`folderPath` must be a string" });
  }
  const folderPath =
    body.folderPath === undefined
      ? undefined
      : parseContextMutationPath(body.folderPath, "folderPath", { allowRoot: true });
  let destination: CreateUntitledDestination | undefined;
  if (body.destination !== undefined) {
    if (!body.destination || typeof body.destination !== "object") {
      throw createError({ statusCode: 400, message: "`destination` must be an object" });
    }
    const raw = body.destination as Record<string, unknown>;
    destination = {
      parent: parseDestinationParent(raw.parent),
      name: parseContextMutationName(raw.name, "destination.name"),
    };
  }
  return {
    documentId: body.documentId,
    ...(folderPath ? { folderPath } : {}),
    ...(destination ? { destination } : {}),
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
  parent: Extract<CreateUntitledDestination["parent"], { kind: "root" }>,
): Promise<string> {
  const { scheme, owner } = parent;
  let authority: CanonicalContextAuthority = { kind: "contextual" };
  if (owner.rootThreadId) {
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

export async function createUntitledContextDocument(input: {
  port: ContextPort;
  userId: string;
  scheme: Parameters<typeof toUri>[0];
  workId: string | null;
  authority?: CanonicalContextAuthority;
  body: CreateUntitledBody;
  /** Resolves a root-kind destination's scheme root; folder-kind parents name no scheme. */
  destinationRootUri?: string;
  authorizeDestination?: (uri: string) => Promise<boolean>;
}): Promise<CreateUntitledContextDocumentAnswer> {
  const { destination } = input.body;
  const homeUri =
    destination?.parent.kind === "root" && input.destinationRootUri
      ? input.destinationRootUri
      : toUri(input.scheme, input.body.folderPath ?? "", input.authority);
  const result = await input.port.createUntitledDocument(homeUri, {
    documentId: input.body.documentId,
    origin: { type: "human", userId: input.userId },
    ...(destination ? { destination } : {}),
    ...(input.authorizeDestination ? { authorizeDestination: input.authorizeDestination } : {}),
  });
  if (!result.ok) {
    if (result.error.code === "conflict") return { status: "conflict" as const };
    contextErrorToHttp(result.error);
  }
  const value = result.value;
  if (value.status === "joined") {
    return {
      status: "joined",
      documentId: value.documentId,
      address: {
        scheme: value.scheme,
        path: value.path,
        name: value.name,
        ...(value.workId ? { workId: value.workId } : {}),
      },
    };
  }
  return value;
}

export default defineEventHandler(async (event) => {
  const { app, userId, projectId, scheme, workId, authority, port, container, edit } =
    await resolveContextRoute(event, { recoverAcrossProject: true });
  const body = parseCreateUntitledBody(await readBody(event));
  const parent = body.destination?.parent;
  const rootUri =
    parent?.kind === "root" ? await destinationRootUri(app, projectId, parent) : undefined;
  const rootContainer =
    rootUri !== undefined ? await containerOfUri(app, projectId, rootUri) : null;
  const authorizeDestination = async (uri: string) => {
    const target = await containerOfUri(app, projectId, uri);
    if (!target) return false;
    const grant = await app.fileAccess.authorize({ accountId: userId as UserId }, target, "edit");
    return !isFileAccessDenied(grant) && (await app.fileAccess.confirmEdit([grant])).length === 0;
  };
  // The client minted the id, so this is a create into the route's folder, or the destination.
  const result = await edit([container, ...(rootContainer ? [rootContainer] : [])], () =>
    createUntitledContextDocument({
      port,
      userId,
      scheme,
      workId,
      authority,
      body,
      ...(rootUri !== undefined ? { destinationRootUri: rootUri } : {}),
      ...(body.destination ? { authorizeDestination } : {}),
    }),
  );
  if (result.status === "conflict") setResponseStatus(event, 409);
  return result;
});
