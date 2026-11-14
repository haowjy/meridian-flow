/**
 * HTTP orchestration for a move of one document between lists (a project's files and the
 * account's `user://` files): the writer names the document by identity and the source it was
 * last in, and the folder it goes into. File policy grants edit on both ends; the records of
 * both lists are made by the port in one transaction. A move inside one list is not here: the
 * browser writes those records itself in the tree's room.
 */

import type { ContextSiblingPosition } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import {
  type ContextMovedAcrossLists,
  contextPortForProjectAuthorities,
  type UnifiedContextPortFactory,
} from "../domains/context/index.js";
import type { FileAccess } from "../domains/file-policy/index.js";
import {
  type ProjectRepository,
  type ProjectWorkAuthorityResolver,
  requireProjectOwner,
} from "../domains/projects/index.js";
import { parseSiblingPosition } from "./context-destination.js";
import { contextErrorToHttp, throwContextWorkUnavailableHttpError } from "./context-error-http.js";
import {
  containerOf,
  type ResolvedContextLocator,
  resolveLocatorUri,
  throwLocatorRefusal,
} from "./context-locator.js";
import { parseContextMutationName } from "./context-mutation-validation.js";
import { documentTarget, requireFileGrant, withEditGrants } from "./file-access-http.js";

export interface ContextMoveRouteDeps {
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  projectRepo: ProjectRepository;
  contextPorts: UnifiedContextPortFactory;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
}

interface ParsedMove {
  nodeId: string;
  /** The root URI of the source the document was last seen in. */
  from: string;
  /** The folder it goes into, as a URI. */
  to: string;
  name?: string;
  position?: ContextSiblingPosition;
}

function parseMove(body: unknown): ParsedMove {
  if (!body || typeof body !== "object")
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  const raw = body as Record<string, unknown>;
  const expected = raw.expected as Record<string, unknown> | undefined;
  if (expected?.kind !== "file" || typeof expected.nodeId !== "string" || !expected.nodeId.trim())
    throw createError({ statusCode: 400, message: "`expected` names the document to move" });
  for (const field of ["from", "to"] as const)
    if (typeof raw[field] !== "string" || !(raw[field] as string).includes("://"))
      throw createError({ statusCode: 400, message: `\`${field}\` must be a context URI` });
  return {
    nodeId: expected.nodeId,
    from: raw.from as string,
    to: raw.to as string,
    ...(raw.name === undefined ? {} : { name: parseContextMutationName(raw.name, "name") }),
    ...(raw.position === undefined ? {} : { position: parseSiblingPosition(raw.position) }),
  };
}

/** One document moved into a folder of the other list; the answer is where it stands now. */
export async function handleContextMoveRequest(
  deps: ContextMoveRouteDeps,
  input: { projectId: string; userId: string; body: unknown },
): Promise<{ uri: string; moved: Pick<ContextMovedAcrossLists, "node"> }> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  const move = parseMove(input.body);

  const locate = async (uri: string): Promise<ResolvedContextLocator> => {
    const resolved = await resolveLocatorUri(deps, input.projectId, uri);
    if (!resolved.ok) return throwLocatorRefusal(resolved.error);
    if (resolved.value.scope === "chat")
      throw createError({ statusCode: 400, message: "Uploads can't be moved into or out of" });
    return resolved.value;
  };
  const source = await locate(move.from);
  const destination = await locate(move.to);

  const workIds = new Set(
    [source, destination].flatMap((end) =>
      end.scope === "work" ? [end.authority.workId as string] : [],
    ),
  );
  const port = await contextPortForProjectAuthorities({
    deps: { contextPorts: deps.contextPorts, workAuthorityResolver: deps.workAuthorityResolver },
    projectId: input.projectId,
    userId: input.userId,
    workIds,
    primaryWorkId: [...workIds][0] ?? null,
  });
  if (!port) throwContextWorkUnavailableHttpError("work_missing");

  const grants = [
    await requireFileGrant(deps.fileAccess, input.userId, documentTarget(move.nodeId), "edit"),
    await requireFileGrant(
      deps.fileAccess,
      input.userId,
      containerOf(destination, input.projectId),
      "edit",
    ),
  ];
  const moved = await withEditGrants(deps.fileAccess, grants, () =>
    port.moveAcrossLists({ kind: "file", nodeId: move.nodeId }, move.from, {
      folderUri: move.to,
      ...(move.name === undefined ? {} : { name: move.name }),
      ...(move.position ? { position: move.position } : {}),
      origin: { type: "human", userId: input.userId },
    }),
  );
  if (!moved.ok) contextErrorToHttp(moved.error);
  return { uri: moved.value.destinationUri, moved: { node: moved.value.node } };
}
