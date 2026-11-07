/**
 * A create at a writer-chosen destination (a document or a folder) needs more than its route:
 * the destination root's address when the parent is an area root, the container the writer must
 * be able to edit there, and the check on the address the port finally resolves.
 */
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type { ContextCreateDestination } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import type {
  HeldContextNode,
  ProjectContextAvailabilityPort,
} from "../../../../../../domains/context/index.js";
import type { AppServices } from "../../../../../../lib/compose.js";
import {
  parseDestinationParent,
  parseSiblingPosition,
} from "../../../../../../lib/context-destination.js";
import {
  type ContextLocator,
  canEditContextUri,
  containerOfUri,
  locatorUri,
  resolveLocator,
  throwLocatorRefusal,
} from "../../../../../../lib/context-locator.js";
import { parseContextMutationName } from "../../../../../../lib/context-mutation-validation.js";

export function parseCreateDestination(raw: unknown): ContextCreateDestination {
  if (!raw || typeof raw !== "object") {
    throw createError({ statusCode: 400, message: "`destination` must be an object" });
  }
  const fields = raw as Record<string, unknown>;
  return {
    parent: parseDestinationParent(fields.parent),
    name: parseContextMutationName(fields.name, "destination.name"),
    ...(fields.position === undefined ? {} : { position: parseSiblingPosition(fields.position) }),
  };
}

/** The URI of the destination scheme's root for the named owner, for a root-kind parent. */
async function destinationRootUri(
  app: AppServices,
  projectId: string,
  parent: Extract<ContextCreateDestination["parent"], { kind: "root" }>,
): Promise<string> {
  const { scheme, owner } = parent;
  let locator: ContextLocator;
  if (owner.rootThreadId) {
    if (scheme !== "scratch")
      throw createError({ statusCode: 400, message: "Only Scratch belongs to a chat" });
    locator = { scope: "lineage", scheme, rootThreadId: owner.rootThreadId, path: "" };
  } else if (isWorkScopedScheme(scheme)) {
    if (!owner.workId)
      throw createError({ statusCode: 400, message: "Scratch belongs to a Work or a chat" });
    locator = { scope: "work", scheme, workId: owner.workId, path: "" };
  } else locator = { scope: "project", scheme, path: "" } as ContextLocator;
  const resolved = await resolveLocator(app, projectId, locator);
  return resolved.ok ? locatorUri(resolved.value) : throwLocatorRefusal(resolved.error);
}

/**
 * The answer to a create the server already took for `node`, or null when this project holds no
 * such id. The row is read by id, never through the route's Work authority, so a replay is
 * answered by what the server holds and not by who may create there now. Held where the writer
 * can no longer edit (an archived or deleted Work, a lost grant) the id is spent: `conflict`,
 * which the device settles as a refusal, never a retry. Each route spells its held answer.
 */
export async function answerHeldNode(input: {
  availability: ProjectContextAvailabilityPort;
  projectId: string;
  userId: string;
  node: { kind: "document"; id: DocumentId } | { kind: "folder"; id: string };
  /** Whether the writer can still edit where the held node lives. */
  canEdit: (uri: string) => Promise<boolean>;
}): Promise<Extract<HeldContextNode, { kind: "held" }> | "conflict" | null> {
  const held = await input.availability.held(
    { projectId: input.projectId as ProjectId, node: input.node },
    { userId: input.userId },
  );
  if (!held) return null;
  if (held.kind === "unreachable" || !(await input.canEdit(held.address.uri))) return "conflict";
  return held;
}

/** The address a held node answers with, as a create response spells it. */
export function heldNodeAddress(held: Extract<HeldContextNode, { kind: "held" }>) {
  return {
    scheme: held.address.scheme,
    path: held.address.path,
    name: held.address.name,
    ...(held.address.workId ? { workId: held.address.workId } : {}),
  };
}

/**
 * The access a typed destination adds to a create: its root's address and container for a
 * root-kind parent, and the check the port runs on the resolved address.
 */
export async function createDestinationAccess(input: {
  app: AppServices;
  userId: string;
  projectId: string;
  destination: ContextCreateDestination;
}) {
  const { app, userId, projectId, destination } = input;
  const parent = destination.parent;
  const rootUri =
    parent.kind === "root" ? await destinationRootUri(app, projectId, parent) : undefined;
  const rootContainer =
    rootUri !== undefined ? await containerOfUri(app, projectId, rootUri) : null;
  return {
    rootUri,
    rootContainer,
    authorizeDestination: canEditContextUri(app, { userId, projectId }),
  };
}
