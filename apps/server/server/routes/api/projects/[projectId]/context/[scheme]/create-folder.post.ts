/**
 * Materializes a client-minted folder at the writer's destination, so the writer's next command
 * can name it before this answer arrives. A replay of the same id answers `already-exists`; a
 * visible name taken at the destination leaves the folder at the first free name.
 */
import type { CanonicalContextAuthority } from "@meridian/contracts/context-uri";
import type {
  ContextCreateDestination,
  CreateContextFolderResponse,
} from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import type { ContextPort } from "../../../../../../domains/context/index.js";
import { withDurableIntentInterruptBoundary } from "../../../../../../shared/interrupt-boundary.js";
import { createDestinationAccess, parseCreateDestination } from "./_create-destination.js";
import { contextErrorToHttp, resolveContextRoute, toUri } from "./_helpers.js";

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
  if (!result.ok) contextErrorToHttp(result.error);
  return result.value;
}

export default defineEventHandler((event) =>
  withDurableIntentInterruptBoundary(async () => {
    const { app, userId, projectId, scheme, authority, port, container, edit } =
      await resolveContextRoute(event, { recoverAcrossProject: true });
    const body = parseCreateFolderBody(await readBody(event));
    const access = await createDestinationAccess({
      app,
      userId,
      projectId,
      destination: body.destination,
    });
    return edit([container, ...(access.rootContainer ? [access.rootContainer] : [])], () =>
      createContextFolder({
        port,
        userId,
        scheme,
        authority,
        body,
        ...(access.rootUri !== undefined ? { destinationRootUri: access.rootUri } : {}),
        authorizeDestination: access.authorizeDestination,
      }),
    );
  }),
);
