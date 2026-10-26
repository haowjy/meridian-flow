/**
 * Materializes a client-minted folder at the writer's destination, so the writer's next command
 * can name it before this answer arrives. A replay of the same id answers `already-exists`; a
 * visible name taken at the destination leaves the folder at the first free name.
 *
 * The id is the create's receipt, read before any authority over the destination: a replay
 * of a create the server took is answered from what it holds (see `answerHeldFolder`), so a
 * final refusal always means the server holds no such id and the same id can be placed again.
 */
import type { CanonicalContextAuthority } from "@meridian/contracts/context-uri";
import type {
  ContextCreateDestination,
  CreateContextFolderResponse,
} from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import type {
  ContextPort,
  ProjectContextAvailabilityPort,
} from "../../../../../../domains/context/index.js";
import { withDurableIntentInterruptBoundary } from "../../../../../../shared/interrupt-boundary.js";
import {
  answerHeldNode,
  canEditContextUri,
  createDestinationAccess,
  heldNodeAddress,
  parseCreateDestination,
} from "./_create-destination.js";
import {
  contextErrorToHttp,
  requireProjectRouteContext,
  resolveContextRouteFor,
  toUri,
} from "./_helpers.js";

interface CreateFolderBody {
  folderId: string;
  destination: ContextCreateDestination;
}

export function parseCreateFolderBody(raw: unknown): CreateFolderBody {
  if (!raw || typeof raw !== "object") {
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  }
  const body = raw as { folderId?: unknown; destination?: unknown };
  if (typeof body.folderId !== "string" || body.folderId.trim() === "") {
    throw createError({ statusCode: 400, message: "`folderId` is required" });
  }
  return { folderId: body.folderId, destination: parseCreateDestination(body.destination) };
}

export async function createContextFolder(input: {
  port: ContextPort;
  userId: string;
  scheme: Parameters<typeof toUri>[0];
  authority?: CanonicalContextAuthority;
  body: CreateFolderBody;
  /** Resolves a root-kind destination's scheme root; folder-kind parents name no scheme. */
  destinationRootUri?: string;
  authorizeDestination?: (uri: string) => Promise<boolean>;
}): Promise<CreateContextFolderResponse> {
  const { destination, folderId } = input.body;
  const homeUri =
    destination.parent.kind === "root" && input.destinationRootUri
      ? input.destinationRootUri
      : toUri(input.scheme, "", input.authority);
  const result = await input.port.createFolder(homeUri, {
    folderId,
    origin: { type: "human", userId: input.userId },
    destination,
    ...(input.authorizeDestination ? { authorizeDestination: input.authorizeDestination } : {}),
  });
  if (!result.ok) {
    // A held id is the only conflict this route names, however the port found it.
    if (result.error.code === "conflict") return { status: "conflict" };
    contextErrorToHttp(result.error);
  }
  return result.value;
}

/**
 * The answer to a create the server already took, or null when the project holds no such id.
 * Held where the writer can no longer edit, the id is spent: a conflict, which leaves the
 * device's folder local and needing repair.
 */
export async function answerHeldFolder(input: {
  availability: ProjectContextAvailabilityPort;
  projectId: string;
  userId: string;
  folderId: string;
  canEdit: (uri: string) => Promise<boolean>;
}): Promise<CreateContextFolderResponse | null> {
  const held = await answerHeldNode({ ...input, node: { kind: "folder", id: input.folderId } });
  if (!held) return null;
  if (held === "conflict") return { status: "conflict" };
  return {
    status: "already-exists",
    folderId: held.address.id,
    ...heldNodeAddress(held),
  };
}

export default defineEventHandler((event) =>
  withDurableIntentInterruptBoundary(async () => {
    const context = await requireProjectRouteContext(event);
    const body = parseCreateFolderBody(await readBody(event));
    // The held id is answered before the route: a destination in a deleted Work refuses the
    // route, while a create the server took there must still answer.
    const held = await answerHeldFolder({
      availability: context.app.projectContextAvailability,
      projectId: context.projectId,
      userId: context.userId,
      folderId: body.folderId,
      canEdit: canEditContextUri(context),
    });
    if (held) {
      if (held.status === "conflict") setResponseStatus(event, 409);
      return held;
    }
    const { app, userId, projectId, scheme, authority, port, container, edit } =
      await resolveContextRouteFor(event, context, { recoverAcrossProject: true });
    const access = await createDestinationAccess({
      app,
      userId,
      projectId,
      destination: body.destination,
    });
    return edit([container, ...(access.rootContainer ? [access.rootContainer] : [])], async () => {
      const result = await createContextFolder({
        port,
        userId,
        scheme,
        authority,
        body,
        ...(access.rootUri !== undefined ? { destinationRootUri: access.rootUri } : {}),
        authorizeDestination: access.authorizeDestination,
      });
      if (result.status === "conflict") setResponseStatus(event, 409);
      return result;
    });
  }),
);
