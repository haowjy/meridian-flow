/**
 * HTTP orchestration for one Copy: parse the writer's locators, find each source by its node id
 * (where it stands now, or in Trash), ask file policy for read on each source and `command` on
 * the destination, then hand the port canonical addresses. Everything that writes, and what a
 * closed destination Work answers, happens in the domain command.
 */

import { type DraftId, type DraftOwner, isDraftId } from "@meridian/contracts";
import { formatParsedContextUri, isWorkScopedScheme } from "@meridian/contracts/context-uri";
import { parseHandle } from "@meridian/contracts/handles";
import type {
  ContextDestinationParent,
  ContextSiblingPosition,
  CopyContextEntriesResult,
  CopyContextEntryView,
} from "@meridian/contracts/protocol";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";
import { decodeRoomVersion } from "@meridian/document-model";
import { createError } from "nitro/h3";
import type { Drafts } from "../domains/collab/index.js";
import {
  type ContextCopyRequest,
  type CopySourceView,
  contextPortForProjectAuthorities,
  type ProjectContextAvailabilityPort,
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
  canCommandContextUri,
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
  availability: ProjectContextAvailabilityPort;
  projectRepo: ProjectRepository;
  contextPorts: UnifiedContextPortFactory;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
  drafts: Pick<Drafts, "ownerOf">;
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
  roomVersion?: Uint8Array;
}

interface ParsedCopy {
  operationId: string;
  sources: ParsedCopySource[];
  destination: CopyDestinationLocator;
  destinationView: CopyContextEntryView;
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
    destinationView: parseView(body.destinationView),
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
  const roomVersion = parseRoomVersion(source.roomVersion, expected.kind);
  return {
    locator: parseSourceLocator(source),
    expected: { kind: expected.kind, nodeId: expected.nodeId },
    view,
    ...(source.copyId === undefined
      ? {}
      : { copyId: requireRequestId(source.copyId, "sources[].copyId") }),
    ...(roomVersion ? { roomVersion } : {}),
  };
}

/**
 * The client's vector is for the one room of the one document it holds open: a folder has no
 * such room, and every child has a room of its own. Decoding it here keeps a malformed
 * vector a client error instead of a failure inside the command.
 */
function parseRoomVersion(raw: unknown, kind: "file" | "folder"): Uint8Array | undefined {
  if (raw === undefined) return undefined;
  if (kind === "folder") {
    throw createError({
      statusCode: 400,
      message: "`sources[].roomVersion` is for a document; a folder has no room of its own",
    });
  }
  const bytes = typeof raw === "string" ? Uint8Array.from(Buffer.from(raw, "base64")) : null;
  try {
    if (!bytes || bytes.length === 0) throw new Error("empty");
    for (const vector of decodeRoomVersion(bytes).values()) vector.free();
    return bytes;
  } catch {
    throw createError({
      statusCode: 400,
      message: "`sources[].roomVersion` must be a base64-encoded room version",
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
    if (!workId) throwContextWorkUnavailableHttpError("work_missing");
    return { scope: "work", scheme, workId, path };
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
    if (!isDraftId(view.draft)) {
      throw createError({ statusCode: 400, message: "A draft view names its draft" });
    }
    return { kind: "draft", draft: view.draft };
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
    if (!workId) throwContextWorkUnavailableHttpError("work_missing");
    return { scope: "work", scheme, workId, path };
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
  view: CopySourceView;
  copyId?: string;
  roomVersion?: Uint8Array;
  /** The file-policy target its read is granted on. */
  target: FileTarget;
  /**
   * `trash`: the node is in Trash, so its read is asked as a `command` (a deleted file's `read`
   * is not allowed). `gone`: the project holds no such node, so there is nothing to grant and the
   * command leaves it out.
   */
  held: "live" | "trash" | "gone";
  workId: string | null;
}

export async function handleContextCopyRequest(
  deps: ContextCopyRouteDeps,
  input: { projectId: string; userId: string; body: unknown },
): Promise<CopyContextEntriesResult> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  const copy = parseContextCopy({ body: input.body });

  /** A draft of this project, with whoever names it; any other draft is not found. */
  const owners = new Map<DraftId, DraftOwner>();
  async function draftOwner(view: CopyContextEntryView): Promise<DraftOwner | null> {
    if (view.kind === "live") return null;
    const known = owners.get(view.draft);
    if (known) return known;
    const found = await deps.drafts.ownerOf(view.draft);
    if (found?.draft.projectId !== input.projectId || !found.owner)
      throw createError({ statusCode: 404, message: "Draft not found" });
    owners.set(view.draft, found.owner);
    return found.owner;
  }

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
  const destinationView: CopySourceView = copy.destinationView;
  const destinationOwner = await draftOwner(destinationView);
  // The port's own Work is the destination's: a copy reads its sources and writes only there,
  // so a source Work that has ended must not make the destination unavailable.
  let destinationWorkId: string | null = null;
  if (destinationOwner?.kind === "work") destinationWorkId = destinationOwner.workId;
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
        held: "live",
        workId: null,
      });
      continue;
    }
    // The node is the source wherever it stands now (or stood, in Trash), whatever path the
    // writer saw. A node the project no longer holds keeps the writer's address: the command
    // finds nothing there and leaves it out.
    const held = await deps.availability.held(
      {
        projectId: input.projectId as ProjectId,
        node:
          source.expected.kind === "file"
            ? { kind: "document", id: source.expected.nodeId as DocumentId }
            : { kind: "folder", id: source.expected.nodeId },
        inTrash: true,
      },
      { userId: input.userId },
    );
    const where =
      held?.kind === "held"
        ? await resolveLocatorUri(deps, input.projectId, held.address.uri)
        : null;
    const resolved =
      where?.ok && where.value.scope !== "chat"
        ? where.value
        : await resolveLocator(source.locator);
    const standing = held?.kind === "held" ? (held.inTrash ? "trash" : "live") : "gone";
    const workId = resolved.scope === "work" ? resolved.authority.workId : null;
    if (workId) workIds.add(workId);
    // The port below refuses a Work that isn't this project's (`work_missing`).
    const owner = await draftOwner(source.view);
    if (owner?.kind === "work") workIds.add(owner.workId);
    sources.push({
      uri: locatorUri(resolved),
      expected: source.expected,
      view: source.view,
      ...(source.copyId ? { copyId: source.copyId } : {}),
      ...(source.roomVersion ? { roomVersion: source.roomVersion } : {}),
      target:
        source.expected.kind === "file"
          ? source.view.kind === "draft"
            ? {
                kind: "draft",
                documentId: source.expected.nodeId as DocumentId,
                draftId: source.view.draft,
              }
            : documentTarget(source.expected.nodeId)
          : containerOf(resolved, input.projectId),
      held: standing,
      workId: workId ?? (owner?.kind === "work" ? owner.workId : null),
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
    if (destinationLocator.scope === "work")
      destinationWorkId = destinationLocator.authority.workId;
  }
  if (destinationWorkId) workIds.add(destinationWorkId);

  const port = await contextPortForProjectAuthorities({
    deps: {
      contextPorts: deps.contextPorts,
      workAuthorityResolver: deps.workAuthorityResolver,
    },
    projectId: input.projectId,
    userId: input.userId,
    workIds,
    primaryWorkId: destinationWorkId,
  });
  if (!port) throwContextWorkUnavailableHttpError("work_missing");

  const folder =
    destinationFolderId === null
      ? null
      : await port.resolveFolderUri(destinationFolderId, destinationView);
  const request = (
    destinationUri: string,
    authorizeDestination?: ContextCopyRequest["authorizeDestination"],
  ): ContextCopyRequest => ({
    operationId: copy.operationId,
    sources: sources.map((source) => ({
      uri: source.uri,
      view: source.view,
      expected: source.expected,
      ...(source.copyId ? { copyId: source.copyId } : {}),
      ...(source.roomVersion ? { roomVersion: source.roomVersion } : {}),
    })),
    destinationUri,
    ...(destinationView.kind === "draft" && destinationOwner
      ? {
          destinationDraft: {
            owner: destinationOwner,
            draftId: destinationView.draft,
            threadId: null,
            userId: input.userId as UserId,
          },
        }
      : {}),
    ...(copy.destinationParent ? { destinationParent: copy.destinationParent } : {}),
    ...(copy.position ? { position: copy.position } : {}),
    ...(authorizeDestination ? { authorizeDestination } : {}),
  });
  // A destination folder the project no longer holds: nothing is copied, and the answer says so.
  if (folder && !folder.ok && folder.error.code === "destination_missing") {
    const left = await port.leftOutForMissingFolder(request(destinationFolderId as string));
    if (!left.ok) contextErrorToHttp(left.error);
    return left.value;
  }
  if (folder && !folder.ok) contextErrorToHttp(folder.error);
  const folderUri = folder?.ok ? folder.value.uri : null;
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
    sources.flatMap((source) =>
      source.held === "gone"
        ? []
        : [
            requireFileGrant(
              deps.fileAccess,
              input.userId,
              source.target,
              source.held === "trash" ? "command" : "read",
            ),
          ],
    ),
  );
  const editGrant =
    folderUri === null
      ? await requireFileGrant(
          deps.fileAccess,
          input.userId,
          containerOf(resolvedDestination, input.projectId),
          "command",
        )
      : null;

  const run = () =>
    port.copy(
      request(destinationUri, folderUri === null ? undefined : canCommandContextUri(deps, input)),
    );

  const result = editGrant ? await withEditGrants(deps.fileAccess, [editGrant], run) : await run();
  if (!result.ok) contextErrorToHttp(result.error);
  return result.value;
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
  return formatParsedContextUri("uploads", clean, { kind: "chat", chatRef });
}

function joinPath(base: string, segments: readonly string[]): string {
  return segments.length === 0 ? base : [base.replace(/\/+$/, ""), ...segments].join("/");
}
