/**
 * HTTP orchestration for one Copy: parse the writer's locators, resolve their authorities,
 * ask file policy for read on each source and edit on the destination, then hand the port
 * canonical addresses. Everything that writes happens in the domain command.
 */

import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import { parseHandle } from "@meridian/contracts/handles";
import type {
  ContextDestinationParent,
  ContextSiblingPosition,
  CopyContextEntriesResult,
  CopyContextEntryView,
} from "@meridian/contracts/protocol";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import {
  type ContextPort,
  contextPortForProjectAuthorities,
  parseUnifiedContextUri,
  type UnifiedContextPortFactory,
} from "../domains/context/index.js";
import {
  type FileAccess,
  type FileTarget,
  isFileAccessDenied,
} from "../domains/file-policy/index.js";
import {
  type ProjectRepository,
  type ProjectWorkAuthorityResolver,
  requireProjectOwner,
  type WorkRepository,
} from "../domains/projects/index.js";
import { contextErrorToHttp, throwContextWorkUnavailableHttpError } from "./context-error-http.js";
import {
  type ContextLocator,
  containerOf,
  locatorUri,
  type ResolvedContextLocator,
} from "./context-locator.js";
import { parseDestinationParent } from "./context-move-route.js";
import {
  parseContextMutationName,
  parseContextMutationPath,
} from "./context-mutation-validation.js";
import { documentTarget, requireFileGrant, withEditGrants } from "./file-access-http.js";
import { requireRequestId } from "./request-id.js";

export interface ContextCopyRouteDeps {
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  projectRepo: ProjectRepository;
  workRepo: WorkRepository;
  contextPorts: UnifiedContextPortFactory;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
}

/** A copy source: a context locator, or one chat's uploads. */
type CopySourceLocator =
  | ContextLocator
  | { scope: "chat"; scheme: "uploads"; chatRef: string; path: string };

type CopyDestinationLocator =
  | ContextLocator
  | { scope: "folder"; folderId: string; createFolders?: string[] };

interface ParsedCopySource {
  locator: CopySourceLocator;
  expected: { kind: "file" | "folder"; nodeId: string };
  view: CopyContextEntryView;
  stateVector?: string;
}

interface ParsedCopy {
  operationId: string;
  sources: ParsedCopySource[];
  destination: CopyDestinationLocator;
  destinationParent?: ContextDestinationParent;
  position?: ContextSiblingPosition;
}

export function parseContextCopy(input: { body: unknown }): ParsedCopy {
  if (!input.body || typeof input.body !== "object") {
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  }
  const body = input.body as Record<string, unknown>;
  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    throw createError({ statusCode: 400, message: "A copy needs at least one source" });
  }
  return {
    operationId: requireRequestId(body.operationId, "operationId"),
    sources: body.sources.map(parseSource),
    destination: parseDestination(body),
    ...(body.destinationParent === undefined
      ? {}
      : { destinationParent: parseDestinationParent(body.destinationParent) }),
    ...(body.position === undefined ? {} : { position: parsePosition(body.position) }),
  };
}

function parseSource(raw: unknown): ParsedCopySource {
  if (!raw || typeof raw !== "object") {
    throw createError({ statusCode: 400, message: "Each source must be an object" });
  }
  const source = raw as Record<string, unknown>;
  const expected = source.expected as Record<string, unknown> | undefined;
  if (
    !expected ||
    (expected.kind !== "file" && expected.kind !== "folder") ||
    typeof expected.nodeId !== "string" ||
    !expected.nodeId.trim()
  ) {
    throw createError({ statusCode: 400, message: "Each source names its expected identity" });
  }
  const view = parseView(source.view);
  if (typeof source.stateVector === "string" && source.stateVector.trim() === "") {
    throw createError({ statusCode: 400, message: "`sources[].stateVector` must be base64" });
  }
  return {
    locator: parseSourceLocator(source),
    expected: { kind: expected.kind, nodeId: expected.nodeId },
    view,
    ...(typeof source.stateVector === "string" ? { stateVector: source.stateVector } : {}),
  };
}

function parseSourceLocator(source: Record<string, unknown>): CopySourceLocator {
  const scheme = source.scheme;
  if (!isProjectContextTreeScheme(scheme)) {
    throw createError({ statusCode: 400, message: "Context scheme is invalid" });
  }
  const path = parseContextMutationPath(source.path, "sources[].path");
  if (scheme === "uploads") {
    if (source.chatRef === undefined) {
      throw createError({
        statusCode: 400,
        message: "An uploads source names the chat it belongs to (`chatRef`)",
      });
    }
    if (typeof source.chatRef !== "string" || parseHandle(source.chatRef)?.kind !== "chat") {
      throw createError({
        statusCode: 400,
        message: "`sources[].chatRef` must be a chat handle like c12",
      });
    }
    return { scope: "chat", scheme: "uploads", chatRef: source.chatRef, path };
  }
  const workId = parseWorkId(source.workId, "sources[].workId");
  if (source.rootThreadId != null) {
    if (scheme !== "scratch" || workId) {
      throw createError({ statusCode: 400, message: "Choose one Scratch owner" });
    }
    return {
      scope: "lineage",
      scheme: "scratch",
      path,
      rootThreadId: requireRequestId(source.rootThreadId, "sources[].rootThreadId"),
    };
  }
  if (isWorkScopedScheme(scheme)) {
    return workId ? { scope: "work", scheme, workId, path } : { scope: "none", scheme, path };
  }
  if (workId !== null) {
    throw createError({ statusCode: 400, message: "`workId` is not valid for this scheme" });
  }
  return { scope: "project", scheme, path };
}

function parseView(raw: unknown): CopyContextEntryView {
  if (raw === undefined) return { kind: "live" };
  if (!raw || typeof raw !== "object") {
    throw createError({ statusCode: 400, message: "Source view is invalid" });
  }
  const view = raw as Record<string, unknown>;
  if (view.kind === "live") return { kind: "live" };
  if (view.kind === "draft") {
    if (typeof view.workId !== "string" || !view.workId.trim()) {
      throw createError({ statusCode: 400, message: "A draft view names its Work" });
    }
    return {
      kind: "draft",
      workId: view.workId as WorkId,
      threadId: requireRequestId(view.threadId, "sources[].view.threadId"),
    };
  }
  throw createError({ statusCode: 400, message: "Source view is invalid" });
}

function parseDestination(body: Record<string, unknown>): CopyDestinationLocator {
  const parent = body.destinationParent as Record<string, unknown> | null | undefined;
  if (parent?.kind === "folder") {
    return {
      scope: "folder",
      folderId: requireRequestId(parent.folderId, "destinationParent.folderId"),
      ...(Array.isArray(parent.createFolders)
        ? {
            createFolders: parent.createFolders.map((segment) =>
              parseContextMutationName(segment, "destinationParent.createFolders"),
            ),
          }
        : {}),
    };
  }
  const scheme = body.destinationScheme;
  if (!isProjectContextTreeScheme(scheme)) {
    throw createError({ statusCode: 400, message: "Destination scheme is invalid" });
  }
  if (scheme === "uploads") {
    throw createError({
      statusCode: 400,
      message: "Uploads is out-only: files can be copied out of it, not into it",
    });
  }
  const path = parseContextMutationPath(body.destinationFolderPath, "destinationFolderPath", {
    allowRoot: true,
  });
  const workId = parseWorkId(body.destinationWorkId, "destinationWorkId");
  if (body.destinationRootThreadId != null) {
    if (scheme !== "scratch" || workId) {
      throw createError({ statusCode: 400, message: "Choose one Scratch owner" });
    }
    return {
      scope: "lineage",
      scheme: "scratch",
      path,
      rootThreadId: requireRequestId(body.destinationRootThreadId, "destinationRootThreadId"),
    };
  }
  if (isWorkScopedScheme(scheme)) {
    return workId ? { scope: "work", scheme, workId, path } : { scope: "none", scheme, path };
  }
  if (workId !== null) {
    throw createError({ statusCode: 400, message: "`workId` is not valid for this scheme" });
  }
  return { scope: "project", scheme, path };
}

function parsePosition(raw: unknown): ContextSiblingPosition {
  const position = raw as Record<string, unknown> | null;
  if (!position || typeof position !== "object") {
    throw createError({ statusCode: 400, message: "Position is invalid" });
  }
  if (position.kind === "start" || position.kind === "end") return { kind: position.kind };
  if (position.kind === "before" || position.kind === "after") {
    return {
      kind: position.kind,
      siblingId: requireRequestId(position.siblingId, "position.siblingId"),
    };
  }
  throw createError({ statusCode: 400, message: "Position is invalid" });
}

function parseWorkId(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw createError({ statusCode: 400, message: `\`${field}\` must be a non-empty string` });
  }
  return raw.trim();
}

interface ResolvedSource {
  uri: string;
  expected: { kind: "file" | "folder"; nodeId: string };
  view: CopyContextEntryView;
  stateVector?: string;
  /** The file-policy target its read is granted on. */
  target: FileTarget;
  workId: string | null;
}

export async function handleContextCopyRequest(
  deps: ContextCopyRouteDeps,
  input: { projectId: string; userId: string; body: unknown },
): Promise<CopyContextEntriesResult> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  const copy = parseContextCopy({ body: input.body });

  async function resolveLocator(
    locator: ContextLocator,
    options: { destination?: boolean } = {},
  ): Promise<ResolvedContextLocator> {
    if (locator.scope === "project") return locator;
    if (locator.scope === "lineage") {
      const lineage = await deps.contextPorts.lineages.byId(input.projectId, locator.rootThreadId);
      if (!lineage) {
        if (options.destination) throwContextWorkUnavailableHttpError("work_missing");
        throw createError({ statusCode: 404, message: "Chat not found" });
      }
      return { ...locator, authority: { kind: "lineage", rootThreadRef: lineage.rootThreadRef } };
    }
    const authority =
      locator.scope === "none"
        ? await deps.workAuthorityResolver.noWork(input.projectId)
        : await deps.workAuthorityResolver.byId(input.projectId, locator.workId);
    if (!authority) throwContextWorkUnavailableHttpError("work_missing");
    return { scope: "work", scheme: locator.scheme, path: locator.path, authority };
  }

  const sources: ResolvedSource[] = [];
  const workIds = new Set<string>();
  for (const source of copy.sources) {
    if (source.locator.scope === "chat") {
      const chat = await deps.contextPorts.chats.byRef(input.projectId, source.locator.chatRef);
      if (!chat?.live) throw createError({ statusCode: 404, message: "Chat not found" });
      sources.push({
        uri: uploadsUri(source.locator.chatRef, source.locator.path),
        expected: source.expected,
        view: { kind: "live" },
        target: {
          kind: "container",
          scheme: "uploads",
          owner: {
            scope: "chat",
            projectId: input.projectId as ProjectId,
            threadId: chat.chatId as ThreadId,
          },
        },
        workId: null,
      });
      continue;
    }
    const resolved = await resolveLocator(source.locator);
    const workId = resolved.scope === "work" ? resolved.authority.workId : null;
    if (workId) workIds.add(workId);
    if (source.view.kind === "draft") workIds.add(source.view.workId);
    sources.push({
      uri: locatorUri(resolved),
      expected: source.expected,
      view: source.view,
      ...(source.stateVector ? { stateVector: source.stateVector } : {}),
      target:
        source.expected.kind === "file"
          ? documentTarget(source.expected.nodeId)
          : containerOf(resolved, input.projectId),
      workId: workId ?? (source.view.kind === "draft" ? source.view.workId : null),
    });
  }

  let destinationLocator: ResolvedContextLocator | null = null;
  let destinationFolderId: string | null = null;
  let createFolders: readonly string[] = [];
  if (copy.destination.scope === "folder") {
    destinationFolderId = copy.destination.folderId;
    createFolders = copy.destination.createFolders ?? [];
  } else {
    destinationLocator = await resolveLocator(copy.destination, { destination: true });
    if (destinationLocator.scope === "work") workIds.add(destinationLocator.authority.workId);
  }

  const works = await deps.workRepo.listByProject(input.projectId, { lifecycle: "all" });
  const port = await contextPortForProjectAuthorities({
    deps: {
      contextPorts: deps.contextPorts,
      works: deps.workRepo,
      workAuthorityResolver: deps.workAuthorityResolver,
    },
    projectId: input.projectId,
    userId: input.userId,
    workIds,
    primaryWorkId: [...workIds][0] ?? null,
    projectWorks: works,
  });
  if (!port) throwContextWorkUnavailableHttpError("work_missing");

  const folderUri =
    destinationFolderId === null ? null : await resolveFolderUri(port, destinationFolderId);
  const destinationUri =
    folderUri === null
      ? locatorUri(destinationLocator as ResolvedContextLocator)
      : joinPath(folderUri, createFolders);
  const resolvedDestination =
    folderUri === null
      ? (destinationLocator as ResolvedContextLocator)
      : await resolveLocatorUri(deps, input.projectId, folderUri);
  if (!resolvedDestination) {
    contextErrorToHttp({ code: "destination_missing", uri: destinationUri });
  }

  await Promise.all(
    sources.map((source) => requireFileGrant(deps.fileAccess, input.userId, source.target, "read")),
  );
  const editGrant =
    folderUri === null
      ? await requireFileGrant(
          deps.fileAccess,
          input.userId,
          containerOf(resolvedDestination, input.projectId),
          "edit",
        )
      : null;

  const run = () =>
    port.copy({
      operationId: copy.operationId,
      sources: sources.map((source) => ({
        uri: source.uri,
        view: source.view,
        expected: source.expected,
        ...(source.stateVector ? { stateVector: source.stateVector } : {}),
      })),
      destinationUri,
      ...(copy.destinationParent ? { destinationParent: copy.destinationParent } : {}),
      ...(copy.position ? { position: copy.position } : {}),
      ...(folderUri === null
        ? {}
        : {
            authorizeDestination: async (uri: string) => {
              const target = await resolveLocatorUri(deps, input.projectId, uri);
              if (!target) return false;
              const grant = await deps.fileAccess.authorize(
                { accountId: input.userId as UserId },
                containerOf(target, input.projectId),
                "edit",
              );
              return (
                !isFileAccessDenied(grant) &&
                (await deps.fileAccess.confirmEdit([grant])).length === 0
              );
            },
          }),
    });

  const result = editGrant ? await withEditGrants(deps.fileAccess, [editGrant], run) : await run();
  if (!result.ok) contextErrorToHttp(result.error);
  return result.value;
}

async function resolveFolderUri(port: ContextPort, folderId: string): Promise<string> {
  const resolved = await port.resolveFolderUri(folderId);
  if (!resolved.ok) contextErrorToHttp(resolved.error);
  return resolved.value.uri;
}

/** A resolved destination URI, for the file-policy recheck under the command's locks. */
async function resolveLocatorUri(
  deps: ContextCopyRouteDeps,
  projectId: string,
  uri: string,
): Promise<ResolvedContextLocator | null> {
  const parsed = parseUnifiedContextUri(uri);
  if (!parsed.ok) return null;
  const { scheme, path, authority } = parsed.value;
  if (scheme === "uploads") return null;
  if (authority.kind === "work") {
    const resolved = await deps.workAuthorityResolver.byHandle(projectId, authority.workHandle);
    if (!resolved) return null;
    return { scope: "work", scheme: scheme as never, path, authority: resolved };
  }
  if (authority.kind === "lineage") {
    const lineage = await deps.contextPorts.lineages.byRef(projectId, authority.rootThreadRef);
    if (!lineage) return null;
    return {
      scope: "lineage",
      scheme: "scratch",
      path,
      rootThreadId: lineage.rootThreadId,
      authority: { kind: "lineage", rootThreadRef: authority.rootThreadRef },
    };
  }
  return { scope: "project", scheme: scheme as never, path };
}

function uploadsUri(chatRef: string, path: string): string {
  const clean = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return clean ? `uploads://@${chatRef}/${clean}` : `uploads://@${chatRef}/`;
}

function joinPath(base: string, segments: readonly string[]): string {
  return segments.length === 0 ? base : [base.replace(/\/+$/, ""), ...segments].join("/");
}
