/**
 * The destination a request names, as a move, a copy and a create all carry it: a parent by
 * identity (a folder id, or a scheme root and its owner) and a sibling position.
 */
import type { ContextSiblingPosition, MoveContextEntryRequest } from "@meridian/contracts/protocol";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import { parseContextMutationName } from "./context-mutation-validation.js";
import { requireRequestId } from "./request-id.js";

function parseWorkId(raw: unknown) {
  const field = "destinationParent.owner.workId";
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw createError({ statusCode: 400, message: `\`${field}\` must be a non-empty string` });
  }
  return requireRequestId(raw.trim(), field);
}

/** A parent folder, or a scheme root and its owner, each with the missing-folder suffix (`createFolders`). */
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
        workId: parseWorkId(owner.workId),
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
