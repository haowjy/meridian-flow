/**
 * HTTP orchestration for one Copy: parse the writer's locators, resolve their authorities,
 * ask file policy for read on each source and edit on the destination, then hand the port
 * canonical addresses. Everything that writes happens in the domain command.
 */

import { type DraftOwnerKey, draftOwnerFromKey, parseDraftOwnerKey } from "@meridian/contracts";
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import { parseHandle } from "@meridian/contracts/handles";
import type {
  ContextDestinationParent,
  ContextSiblingPosition,
  CopyContextEntriesResult,
  CopyContextEntryView,
} from "@meridian/contracts/protocol";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import { decodeStateVector } from "yjs";
import {
  type ContextPort,
  type CopySourceView,
  contextPortForProjectAuthorities,
  parseUnifiedContextUri,
  type UnifiedContextPortFactory,
} from "../domains/context/index.js";
import type { FileAccess, FileTarget } from "../domains/file-policy/index.js";
import {
  type ProjectRepository,
  type ProjectWorkAuthorityResolver,
  requireProjectOwner,
} from "../domains/projects/index.js";
import { parseDestinationParent, parseSiblingPosition } from "./context-destination.js";
import { contextErrorToHttp, throwContextWorkUnavailableHttpError } from "./context-error-http.js";
import {
  type ContextLocator,
  canEditContextUri,
  containerOf,
  locatorUri,
  type ResolvedContextLocator,
  resolveLocator as resolveLocatorFor,
  resolveLocatorUri,
  throwLocatorRefusal,
} from "./context-locator.js";
import {
  parseContextMutationName,
  parseContextMutationPath,
} from "./context-mutation-validation.js";
import { documentTarget, requireFileGrant, withEditGrants } from "./file-access-http.js";
import { requireRequestId } from "./request-id.js";

export interface ContextCopyRouteDeps {
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  projectRepo: ProjectRepository;
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
  copyId?: string;
  stateVector?: Uint8Array;
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
  const sources = body.sources.map(parseSource);
  const copyIds = new Set<string>();
  for (const source of sources) {
    if (!source.copyId) continue;
    if (copyIds.has(source.copyId)) {
      throw createError({ statusCode: 400, message: "`sources[].copyId` values must be distinct" });
    }
    copyIds.add(source.copyId);
  }
  return {
    operationId: requireRequestId(body.operationId, "operationId"),
    sources,
    destination: parseDestination(body),
    ...(body.destinationParent === undefined
      ? {}
      : { destinationParent: parseDestinationParent(body.destinationParent) }),
    ...(body.position === undefined ? {} : { position: parseSiblingPosition(body.position) }),
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
  const stateVector = parseStateVector(source.stateVector, expected.kind);
  return {
    locator: parseSourceLocator(source),
    expected: { kind: expected.kind, nodeId: expected.nodeId },
    view,
    ...(source.copyId === undefined
      ? {}
      : { copyId: requireRequestId(source.copyId, "sources[].copyId") }),
    ...(stateVector ? { stateVector } : {}),
  };
}

/**
 * The client's vector is for the one room of the one document it holds open: a folder has no
 * such room, and every child's room is a different Y.Doc. Decoding it here keeps a malformed
 * vector a client error instead of a failure inside the command.
 */
function parseStateVector(raw: unknown, kind: "file" | "folder"): Uint8Array | undefined {
  if (raw === undefined) return undefined;
  if (kind === "folder") {
    throw createError({
      statusCode: 400,
      message: "`sources[].stateVector` is for a document; a folder has no room of its own",
    });
  }
  const bytes = typeof raw === "string" ? Uint8Array.from(Buffer.from(raw, "base64")) : null;
  try {
    if (!bytes || bytes.length === 0) throw new Error("empty");
    decodeStateVector(bytes);
    return bytes;
  } catch {
    throw createError({
      statusCode: 400,
      message: "`sources[].stateVector` must be a base64-encoded Yjs state vector",
    });
  }
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

/** The wire view with its draft owner resolved inside the project. */
function copyView(view: CopyContextEntryView, projectId: ProjectId): CopySourceView {
  if (view.kind === "live") return view;
  const owner = draftOwnerFromKey(view.owner, projectId);
  if (!owner) throw createError({ statusCode: 400, message: "A draft view names its owner" });
  return { kind: "draft", owner };
}

function parseView(raw: unknown): CopyContextEntryView {
  if (raw === undefined) return { kind: "live" };
  if (!raw || typeof raw !== "object") {
    throw createError({ statusCode: 400, message: "Source view is invalid" });
  }
  const view = raw as Record<string, unknown>;
  if (view.kind === "live") return { kind: "live" };
  if (view.kind === "draft") {
    if (typeof view.owner !== "string" || !parseDraftOwnerKey(view.owner)) {
      throw createError({ statusCode: 400, message: "A draft view names its owner" });
    }
    return { kind: "draft", owner: view.owner as DraftOwnerKey };
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
  if (scheme === "uploads") throw uploadsOutOnly();
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

/** Uploads is where a chat's files arrive; nothing is copied into it, whichever way it is named. */
function uploadsOutOnly() {
  return createError({
    statusCode: 400,
    message: "Uploads is out-only: files can be copied out of it, not into it",
  });
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
  copyId?: string;
  stateVector?: Uint8Array;
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
    const resolved = await resolveLocatorFor(deps, input.projectId, locator);
    if (resolved.ok) return resolved.value;
    // A destination chat that is gone reads as an unavailable owner, a source's as a 404.
    if (options.destination && resolved.error.reason === "chat_missing")
      throwContextWorkUnavailableHttpError("work_missing");
    return throwLocatorRefusal(resolved.error);
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
        ...(source.copyId ? { copyId: source.copyId } : {}),
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
    // The port below refuses a Work that isn't this project's (`work_missing`).
    const draftOwner =
      source.view.kind === "draft"
        ? draftOwnerFromKey(source.view.owner, input.projectId as ProjectId)
        : null;
    if (draftOwner?.kind === "work") workIds.add(draftOwner.workId);
    sources.push({
      uri: locatorUri(resolved),
      expected: source.expected,
      view: source.view,
      ...(source.copyId ? { copyId: source.copyId } : {}),
      ...(source.stateVector ? { stateVector: source.stateVector } : {}),
      target:
        source.expected.kind === "file"
          ? documentTarget(source.expected.nodeId)
          : containerOf(resolved, input.projectId),
      workId: workId ?? (draftOwner?.kind === "work" ? draftOwner.workId : null),
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

  const port = await contextPortForProjectAuthorities({
    deps: {
      contextPorts: deps.contextPorts,
      workAuthorityResolver: deps.workAuthorityResolver,
    },
    projectId: input.projectId,
    userId: input.userId,
    workIds,
    primaryWorkId: [...workIds][0] ?? null,
  });
  if (!port) throwContextWorkUnavailableHttpError("work_missing");

  const folderUri =
    destinationFolderId === null ? null : await resolveFolderUri(port, destinationFolderId);
  // A folder named by identity can live in Uploads too, and is refused like the path form.
  if (folderUri !== null) {
    const parsed = parseUnifiedContextUri(folderUri);
    if (parsed.ok && parsed.value.scheme === "uploads") throw uploadsOutOnly();
  }
  const destinationUri =
    folderUri === null
      ? locatorUri(destinationLocator as ResolvedContextLocator)
      : joinPath(folderUri, createFolders);
  const resolvedDestination =
    folderUri === null
      ? (destinationLocator as ResolvedContextLocator)
      : await resolveDestinationUri(deps, input.projectId, folderUri);
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
        view: copyView(source.view, input.projectId as ProjectId),
        expected: source.expected,
        ...(source.copyId ? { copyId: source.copyId } : {}),
        ...(source.stateVector ? { stateVector: source.stateVector } : {}),
      })),
      destinationUri,
      ...(copy.destinationParent ? { destinationParent: copy.destinationParent } : {}),
      ...(copy.position ? { position: copy.position } : {}),
      ...(folderUri === null ? {} : { authorizeDestination: canEditContextUri(deps, input) }),
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
async function resolveDestinationUri(
  deps: ContextCopyRouteDeps,
  projectId: string,
  uri: string,
): Promise<ResolvedContextLocator | null> {
  const resolved = await resolveLocatorUri(deps, projectId, uri);
  return resolved.ok && resolved.value.scope !== "chat" ? resolved.value : null;
}

function uploadsUri(chatRef: string, path: string): string {
  const clean = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return clean ? `uploads://@${chatRef}/${clean}` : `uploads://@${chatRef}/`;
}

function joinPath(base: string, segments: readonly string[]): string {
  return segments.length === 0 ? base : [base.replace(/\/+$/, ""), ...segments].join("/");
}
