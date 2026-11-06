/**
 * The move behind POST /api/projects/:projectId/context/entries/:entryId/move: one file or folder,
 * found by its id and moved or renamed. The request names no path and no owner; the row says where
 * it stands. Anything the request omits keeps the row's current value (see `MoveContextEntryRequest`).
 *
 * Access, in order: the project is the user's; a recorded outcome for this operation answers
 * first, so a resend of a committed move is not refused for the row having moved on; the project
 * holds the row (`locateEntry`); edit on the document, or on the area a folder is in; edit on the
 * destination area, except under a destination folder, which is rechecked inside the locks.
 */

import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type {
  ContextMoveResult,
  ContextSiblingPosition,
  MoveContextEntryRequest,
  MoveContextEntryResult,
} from "@meridian/contracts/protocol";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import {
  contextPortForProjectAuthorities,
  type ProjectContextAvailabilityPort,
  type ProjectContextFsScheme,
  parseUnifiedContextUri,
  type UnifiedContextPortFactory,
  type WorkScopedContextFsScheme,
} from "../domains/context/index.js";
import { type FileAccess, isFileAccessDenied } from "../domains/file-policy/index.js";
import {
  type ProjectRepository,
  type ProjectWorkAuthorityResolver,
  requireProjectOwner,
} from "../domains/projects/index.js";
import { locateEntry, replayedResult } from "./context-entry-route.js";
import { contextErrorToHttp, throwContextWorkUnavailableHttpError } from "./context-error-http.js";
import {
  type ContextLocator,
  containerOf,
  locatorUri,
  type ResolvedContextLocator,
  resolveLocatorUri,
  throwLocatorRefusal,
} from "./context-locator.js";
import { parseContextMutationName } from "./context-mutation-validation.js";
import { documentTarget, requireFileGrant, withEditGrants } from "./file-access-http.js";
import { requireRequestId } from "./request-id.js";

export interface ContextMoveRouteDeps {
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  projectRepo: ProjectRepository;
  contextPorts: UnifiedContextPortFactory;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
  availability: ProjectContextAvailabilityPort;
}

export interface ParsedContextMove {
  operationId: string;
  kind: MoveContextEntryRequest["expected"]["kind"];
  destinationParent?: MoveContextEntryRequest["destinationParent"];
  position?: MoveContextEntryRequest["position"];
  name?: string;
}

function uploadsNotMovable() {
  return createError({
    statusCode: 400,
    message: "Uploads belong to the chat that received them and can't be moved",
  });
}

function parseWorkId(raw: unknown, field: "destinationWorkId") {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw createError({ statusCode: 400, message: `\`${field}\` must be a non-empty string` });
  }
  return requireRequestId(raw.trim(), field);
}

/** The area a destination root names: a scheme and its owner, with the folders created beneath it. */
function parseRootLocator(
  parent: Extract<NonNullable<MoveContextEntryRequest["destinationParent"]>, { kind: "root" }>,
): ContextLocator {
  const path = (parent.createFolders ?? []).join("/");
  const { scheme } = parent;
  if (scheme === "uploads") throw uploadsNotMovable();
  const { workId, rootThreadId } = parent.owner;
  if (rootThreadId != null) {
    if (scheme !== "scratch" || workId)
      throw createError({ statusCode: 400, message: "Choose one Scratch owner" });
    return { scope: "lineage", scheme: "scratch", path, rootThreadId };
  }
  if (isWorkScopedScheme(scheme)) {
    return workId
      ? { scope: "work", scheme: scheme as WorkScopedContextFsScheme, workId, path }
      : { scope: "none", scheme, path };
  }
  if (workId)
    throw createError({
      statusCode: 400,
      message: `\`destinationWorkId\` is not valid for ${scheme}`,
    });
  return { scope: "project", scheme: scheme as ProjectContextFsScheme, path };
}

/**
 * A writer-selected parent folder, by identity: a folder id, or a scheme root and its
 * owner, each with the missing-folder suffix (`createFolders`). Moves and creates share it.
 */
export function parseDestinationParent(
  raw: unknown,
): NonNullable<MoveContextEntryRequest["destinationParent"]> {
  const parent = raw as Record<string, unknown> | null;
  let destinationParent: NonNullable<MoveContextEntryRequest["destinationParent"]>;
  if (parent?.kind === "folder") {
    destinationParent = {
      kind: "folder",
      folderId: requireRequestId(parent.folderId, "destinationParent.folderId"),
    };
  } else if (
    parent?.kind === "root" &&
    isProjectContextTreeScheme(parent.scheme) &&
    parent.owner &&
    typeof parent.owner === "object"
  ) {
    const owner = parent.owner as Record<string, unknown>;
    destinationParent = {
      kind: "root",
      scheme: parent.scheme,
      owner: {
        workId: parseWorkId(owner.workId, "destinationWorkId"),
        ...(typeof owner.workHandle === "string" || owner.workHandle === null
          ? { workHandle: owner.workHandle }
          : {}),
        ...(owner.rootThreadId != null
          ? {
              rootThreadId: requireRequestId(
                owner.rootThreadId,
                "destinationParent.owner.rootThreadId",
              ),
              rootThreadRef: typeof owner.rootThreadRef === "string" ? owner.rootThreadRef : null,
            }
          : {}),
      },
    };
  } else throw createError({ statusCode: 400, message: "Destination parent is invalid" });
  if (parent.createFolders !== undefined) {
    if (!Array.isArray(parent.createFolders))
      throw createError({
        statusCode: 400,
        message: "Destination folder suffix must be an array",
      });
    destinationParent.createFolders = parent.createFolders.map((segment) =>
      parseContextMutationName(segment, "destinationParent.createFolders"),
    );
  }
  return destinationParent;
}

/** A sibling position as a move or a create carries it. */
export function parseSiblingPosition(raw: unknown): ContextSiblingPosition {
  if (!raw || typeof raw !== "object")
    throw createError({ statusCode: 400, message: "Position is invalid" });
  const position = raw as Record<string, unknown>;
  if (position.kind === "start" || position.kind === "end") return { kind: position.kind };
  if (position.kind === "before" || position.kind === "after")
    return {
      kind: position.kind,
      siblingId: requireRequestId(position.siblingId, "position.siblingId"),
    };
  throw createError({ statusCode: 400, message: "Position is invalid" });
}

export function parseContextMove(body: unknown): ParsedContextMove {
  if (!body || typeof body !== "object") {
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  }
  const fields = body as Record<string, unknown>;
  const expected = fields.expected as Record<string, unknown> | undefined;
  if (!expected || (expected.kind !== "file" && expected.kind !== "folder")) {
    throw createError({ statusCode: 400, message: "Expected source kind is required" });
  }
  const destinationParent =
    fields.destinationParent === undefined
      ? undefined
      : parseDestinationParent(fields.destinationParent);
  return {
    operationId: requireRequestId(fields.operationId, "operationId"),
    kind: expected.kind,
    ...(destinationParent ? { destinationParent } : {}),
    ...(fields.position === undefined ? {} : { position: parseSiblingPosition(fields.position) }),
    ...(fields.name === undefined ? {} : { name: parseContextMutationName(fields.name, "name") }),
  };
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "";
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** What the writer sees of a committed move; a replay answers the recorded one the same way. */
function movedResponse(moved: ContextMoveResult): MoveContextEntryResult {
  const destination = parseUnifiedContextUri(moved.destinationUri);
  if (!destination.ok) contextErrorToHttp(destination.error);
  return {
    status: "moved",
    ...(moved.linkUpdate ? { linkUpdate: moved.linkUpdate } : {}),
    scheme: destination.value.scheme as MoveContextEntryResult["scheme"],
    path: moved.destinationPath,
    name: basename(moved.destinationPath),
  };
}

export async function handleContextMoveRequest(
  deps: ContextMoveRouteDeps,
  input: { projectId: string; userId: string; entryId: string; body: unknown },
): Promise<MoveContextEntryResult> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  const move = parseContextMove(input.body);
  const replay = await replayedResult(deps, input, move.operationId, {
    kind: "move",
    expected: { kind: move.kind, nodeId: input.entryId },
    ...(move.destinationParent ? { destinationParent: move.destinationParent } : {}),
    ...(move.position ? { position: move.position } : {}),
    ...(move.name ? { name: move.name } : {}),
  });
  if (replay) {
    if (!replay.ok) contextErrorToHttp(replay.error);
    return movedResponse(replay.value);
  }
  const { address, locator: source } = await locateEntry(deps, { ...input, kind: move.kind });
  if (source.scope === "chat") throw uploadsNotMovable();

  // Where it lands: the parent the writer chose. Without one the mover keeps the folder the row
  // is in under the locks, so the area is all this lookup supplies.
  const parent = move.destinationParent;
  async function destinationLocator(): Promise<{ locator: ResolvedContextLocator; dir: string }> {
    if (!parent) return { locator: source as ResolvedContextLocator, dir: "" };
    if (parent.kind === "folder") {
      const folder = await locateEntry(deps, {
        projectId: input.projectId,
        userId: input.userId,
        entryId: parent.folderId,
        kind: "folder",
        missing: "destination_missing",
      });
      if (folder.locator.scope === "chat") throw uploadsNotMovable();
      return {
        locator: folder.locator,
        dir: joinPath(folder.address.path, (parent.createFolders ?? []).join("/")),
      };
    }
    const root = parseRootLocator(parent);
    return { locator: await resolveRootLocator(root), dir: root.path };
  }
  async function resolveRootLocator(locator: ContextLocator): Promise<ResolvedContextLocator> {
    if (locator.scope === "project") return locator;
    if (locator.scope === "lineage") {
      const lineage = await deps.contextPorts.lineages.byId(input.projectId, locator.rootThreadId);
      if (!lineage) destinationMissing(locator);
      return { ...locator, authority: { kind: "lineage", rootThreadRef: lineage.rootThreadRef } };
    }
    const authority =
      locator.scope === "none"
        ? await deps.workAuthorityResolver.noWork(input.projectId)
        : await deps.workAuthorityResolver.byId(input.projectId, locator.workId);
    // The destination's Work may have retired since the request was prepared: that is move
    // repair, not a missing source.
    if (!authority) destinationMissing(locator);
    return { scope: "work", scheme: locator.scheme, path: locator.path, authority };
  }
  function destinationMissing(locator: ContextLocator): never {
    return contextErrorToHttp({
      code: "destination_missing",
      uri: `${locator.scheme}://${locator.path}`,
    });
  }
  const destination = await destinationLocator();

  const workIds = new Set(
    [source as ResolvedContextLocator, destination.locator].flatMap((locator) =>
      locator.scope === "work" ? [locator.authority.workId] : [],
    ),
  );
  const port = await contextPortForProjectAuthorities({
    deps: {
      contextPorts: deps.contextPorts,
      workAuthorityResolver: deps.workAuthorityResolver,
    },
    projectId: input.projectId,
    userId: input.userId,
    workIds,
    primaryWorkId: source.scope === "work" ? source.authority.workId : [...workIds][0],
  });
  if (!port) throwContextWorkUnavailableHttpError("work_missing");

  // Move and rename need edit on what moves and on the folder it lands in (file-access §2). The
  // grant is on the row `held` names, never on the id the request carried: a join's forward
  // would otherwise authorize one row and move another.
  const containerFor = (locator: ResolvedContextLocator) => containerOf(locator, input.projectId);
  async function resolveDestinationLocator(uri: string): Promise<ResolvedContextLocator> {
    const resolved = await resolveLocatorUri(deps, input.projectId, uri);
    if (!resolved.ok) throwLocatorRefusal(resolved.error);
    if (resolved.value.scope === "chat") throw uploadsNotMovable();
    return resolved.value;
  }
  const moved =
    move.kind === "file"
      ? documentTarget(address.id)
      : containerFor(source as ResolvedContextLocator);
  const grants = [
    await requireFileGrant(deps.fileAccess, input.userId, moved, "edit"),
    ...(parent?.kind === "folder"
      ? []
      : [
          await requireFileGrant(
            deps.fileAccess,
            input.userId,
            containerFor(destination.locator),
            "edit",
          ),
        ]),
  ];
  const result = await withEditGrants(deps.fileAccess, grants, () =>
    port.commitWriterLocation(
      address.uri,
      parent ? locatorUri(destination.locator, destination.dir) : null,
      {
        origin: { type: "human", userId: input.userId },
        expected: { kind: move.kind, nodeId: address.id },
        destinationParent: parent,
        position: move.position,
        ...(move.name ? { name: move.name } : {}),
        operationId: move.operationId,
        authorizeDestination: parent
          ? async (uri) => {
              const target = await resolveDestinationLocator(uri);
              const grant = await deps.fileAccess.authorize(
                { accountId: input.userId as UserId },
                containerFor(target),
                "edit",
              );
              return (
                !isFileAccessDenied(grant) &&
                (await deps.fileAccess.confirmEdit([grant])).length === 0
              );
            }
          : undefined,
      },
    ),
  );
  if (!result.ok) contextErrorToHttp(result.error);
  return movedResponse(result.value);
}
