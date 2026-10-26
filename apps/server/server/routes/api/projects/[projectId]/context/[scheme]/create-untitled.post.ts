/**
 * Materializes a client-minted document without seeding its Yjs content. Nameless it is
 * `Untitled N` in the route's folder. With a `destination` (the writer's New file and a
 * link's Create) it lands at the typed name: a branch's hidden document there is unhidden
 * and the answer is `joined`; a visible node there leaves the create at the free name.
 *
 * The id is the create's receipt, read before any authority over the destination: a replay
 * of a create the server took is answered from what it holds (see `answerHeldCreate`), so
 * a final refusal always means the server holds no such id and the same id can be placed again.
 */
import type { CanonicalContextAuthority } from "@meridian/contracts/context-uri";
import type {
  ContextCreateDestination,
  CreateUntitledContextDocumentAnswer,
} from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import type {
  ContextCreateUntitledDocumentResult,
  ContextPort,
  ProjectContextAvailabilityPort,
} from "../../../../../../domains/context/index.js";
import { parseContextMutationPath } from "../../../../../../lib/context-mutation-validation.js";
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

interface CreateUntitledBody {
  documentId: string;
  folderPath?: string;
  destination?: ContextCreateDestination;
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
  const destination =
    body.destination === undefined ? undefined : parseCreateDestination(body.destination);
  return {
    documentId: body.documentId,
    ...(folderPath ? { folderPath } : {}),
    ...(destination ? { destination } : {}),
  };
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
  return createAnswer(result.value);
}

function createAnswer(
  value: ContextCreateUntitledDocumentResult,
): CreateUntitledContextDocumentAnswer {
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

/**
 * The answer to a create the server already took, or null when the project holds no such id.
 * Held where the writer can no longer edit, the id is spent: a conflict, which the device
 * answers by minting another id for its document. A forward names the id a join replaced, so it
 * answers `joined` at the current document.
 */
export async function answerHeldCreate(input: {
  availability: ProjectContextAvailabilityPort;
  projectId: string;
  userId: string;
  documentId: string;
  canEdit: (uri: string) => Promise<boolean>;
}): Promise<CreateUntitledContextDocumentAnswer | null> {
  const held = await answerHeldNode({
    ...input,
    node: { kind: "document", id: input.documentId as DocumentId },
  });
  if (!held) return null;
  if (held === "conflict") return { status: "conflict" };
  const address = heldNodeAddress(held);
  return held.forwarded
    ? { status: "joined", documentId: held.address.id, address }
    : { status: "already-materialized", documentId: held.address.id, ...address };
}

export default defineEventHandler((event) =>
  withDurableIntentInterruptBoundary(async () => {
    const context = await requireProjectRouteContext(event);
    const body = parseCreateUntitledBody(await readBody(event));
    // The held id is answered before the route: a destination in a deleted Work refuses the
    // route, while a create the server took there must still answer.
    const held = await answerHeldCreate({
      availability: context.app.projectContextAvailability,
      projectId: context.projectId,
      userId: context.userId,
      documentId: body.documentId,
      canEdit: canEditContextUri(context),
    });
    if (held) {
      if (held.status === "conflict") setResponseStatus(event, 409);
      return held;
    }
    const { app, userId, projectId, scheme, workId, authority, port, container, edit } =
      await resolveContextRouteFor(event, context, { recoverAcrossProject: true });
    const access = body.destination
      ? await createDestinationAccess({ app, userId, projectId, destination: body.destination })
      : null;
    // The client minted the id, so this is a create into the route's folder, or the destination.
    const result = await edit(
      [container, ...(access?.rootContainer ? [access.rootContainer] : [])],
      () =>
        createUntitledContextDocument({
          port,
          userId,
          scheme,
          workId,
          authority,
          body,
          ...(access?.rootUri !== undefined ? { destinationRootUri: access.rootUri } : {}),
          ...(access ? { authorizeDestination: access.authorizeDestination } : {}),
        }),
    );
    if (result.status === "conflict") setResponseStatus(event, 409);
    return result;
  }),
);
