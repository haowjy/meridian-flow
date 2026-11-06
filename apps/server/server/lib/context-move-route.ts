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
import type { MoveContextEntryRequest, MoveContextEntryResult } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import {
  moveCommand,
  type ProjectContextFsScheme,
  type WorkScopedContextFsScheme,
} from "../domains/context/index.js";
import { type ProjectRepository, requireProjectOwner } from "../domains/projects/index.js";
import { parseDestinationParent, parseSiblingPosition } from "./context-destination.js";
import { type EntryRouteDeps, locateEntry, runEntryCommand } from "./context-entry-route.js";
import { contextErrorToHttp } from "./context-error-http.js";
import {
  type ContextLocator,
  canEditContextUri,
  containerOf,
  locatorUri,
  type ResolvedContextLocator,
  resolveLocator,
} from "./context-locator.js";
import { parseContextMutationName } from "./context-mutation-validation.js";
import { documentTarget } from "./file-access-http.js";
import { requireRequestId } from "./request-id.js";

export type ContextMoveRouteDeps = EntryRouteDeps & { projectRepo: ProjectRepository };

export interface ParsedContextMove {
  operationId: string;
  kind: MoveContextEntryRequest["kind"];
  destinationParent?: MoveContextEntryRequest["destinationParent"];
  position?: MoveContextEntryRequest["position"];
  name?: string;
}

const UPLOADS_NOT_MOVABLE = "Uploads belong to the chat that received them and can't be moved";

function uploadsNotMovable() {
  return createError({ statusCode: 400, message: UPLOADS_NOT_MOVABLE });
}

/** The area a destination root names: a scheme and its owner, with the folders created beneath it. */
function parseRootLocator(
  parent: Extract<NonNullable<MoveContextEntryRequest["destinationParent"]>, { kind: "root" }>,
): ContextLocator {
  const path = "";
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
      message: `\`destinationParent.owner.workId\` is not valid for ${scheme}`,
    });
  return { scope: "project", scheme: scheme as ProjectContextFsScheme, path };
}

export function parseContextMove(body: unknown): ParsedContextMove {
  if (!body || typeof body !== "object") {
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  }
  const fields = body as Record<string, unknown>;
  if (fields.kind !== "file" && fields.kind !== "folder") {
    throw createError({ statusCode: 400, message: "Entry kind is required" });
  }
  const destinationParent =
    fields.destinationParent === undefined
      ? undefined
      : parseDestinationParent(fields.destinationParent);
  return {
    operationId: requireRequestId(fields.operationId, "operationId"),
    kind: fields.kind,
    ...(destinationParent ? { destinationParent } : {}),
    ...(fields.position === undefined ? {} : { position: parseSiblingPosition(fields.position) }),
    ...(fields.name === undefined ? {} : { name: parseContextMutationName(fields.name, "name") }),
  };
}

const MOVED: MoveContextEntryResult = { status: "moved" };

export async function handleContextMoveRequest(
  deps: ContextMoveRouteDeps,
  input: { projectId: string; userId: string; entryId: string; body: unknown },
): Promise<MoveContextEntryResult> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  const move = parseContextMove(input.body);
  const parent = move.destinationParent;
  const command = moveCommand({ ...move, expected: { kind: move.kind, nodeId: input.entryId } });
  await runEntryCommand(deps, input, {
    kind: move.kind,
    operationId: move.operationId,
    command,
    uploads: UPLOADS_NOT_MOVABLE,
    plan: async ({ address, source }) => {
      // The parent the writer chose; without one the mover keeps the folder the row is in,
      // under the locks, so the area is all this lookup supplies. A folder destination is
      // authorized inside the locks, once the mover has read it again.
      const destination = await destinationLocator(deps, input, source, parent);
      const canEdit = canEditContextUri(deps, input);
      return {
        destination,
        // Move and rename need edit on what moves and on the folder it lands in (file-access
        // §2). The grant is on the row `held` names, never on the id the request carried: a
        // join's forward would otherwise authorize one row and move another.
        grants: [
          move.kind === "file" ? documentTarget(address.id) : containerOf(source, input.projectId),
          ...(parent?.kind === "folder" ? [] : [containerOf(destination, input.projectId)]),
        ],
        commit: (port) =>
          port.commitWriterLocation(
            { kind: move.kind, nodeId: address.id },
            locatorUri(source, ""),
            {
              origin: { type: "human", userId: input.userId },
              destination: !parent
                ? { kind: "keep" }
                : parent.kind === "folder"
                  ? {
                      kind: "folder",
                      folderId: parent.folderId,
                      createFolders: parent.createFolders,
                      authorize: canEdit,
                    }
                  : {
                      kind: "at",
                      folderUri: locatorUri(destination, ""),
                      createFolders: parent.createFolders,
                    },
              position: move.position,
              ...(move.name ? { name: move.name } : {}),
              operation: { id: move.operationId, command },
            },
          ),
      };
    },
  });
  return MOVED;
}

/** The area the destination parent is in, resolved against this project. */
async function destinationLocator(
  deps: ContextMoveRouteDeps,
  input: { projectId: string; userId: string },
  source: ResolvedContextLocator,
  parent: ParsedContextMove["destinationParent"],
): Promise<ResolvedContextLocator> {
  if (!parent) return source;
  if (parent.kind === "folder") {
    const folder = await locateEntry(deps, {
      ...input,
      entryId: parent.folderId,
      kind: "folder",
      missing: "destination_missing",
    });
    if (folder.locator.scope === "chat") throw uploadsNotMovable();
    return folder.locator;
  }
  const root = parseRootLocator(parent);
  const resolved = await resolveLocator(deps, input.projectId, root);
  // The destination's Work may have retired since the request was prepared: that is move
  // repair, not a missing source.
  if (!resolved.ok)
    return contextErrorToHttp({ code: "destination_missing", uri: `${root.scheme}://` });
  return resolved.value;
}
