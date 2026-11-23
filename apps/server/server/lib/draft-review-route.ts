/**
 * Route core for authenticated review of a draft: the list, the per-document hints, and
 * the press (Apply or Discard) with its Undo. A command carries a client `commandId`: the route
 * looks it up first (a resend gets its stored answer), builds the digest envelope, and maps the
 * service's errors to HTTP. Nothing here decides an effect.
 */

import type { CommandId, DraftId } from "@meridian/contracts";
import { draftItemKey, isDraftId, parseDraftItemKey } from "@meridian/contracts";
import { CommandIdSchema } from "@meridian/contracts/commands";
import type {
  DocumentDraftHint,
  DocumentDraftHintsResponse,
  DraftItem,
  DraftItemsResponse,
  PressAction,
  PressResult,
  PressUndoResult,
} from "@meridian/contracts/drafts";
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import { decodeRoomVersion } from "@meridian/document-model";
import { VersionVector } from "loro-crdt";
import { createError } from "nitro/h3";
import { z } from "zod";
import type { DraftReviewItem } from "../domains/collab/domain/draft-review-items.js";
import type { DocumentDraftOrigin } from "../domains/collab/domain/ports/work-draft-pending-store.js";
import { reviewContextLocation } from "../domains/collab/domain/work-draft-review-service.js";
import { WorkLifecycleUnavailableError } from "../domains/projects/domain/work-lifecycle.js";
import {
  type CommandEnvelope,
  type CommandLookup,
  commandDigest,
  replay,
} from "../shared/commands/command-record.js";
import type { AppServices } from "./app.js";
import { throwCommandConflict } from "./command-route.js";
import { throwWorkMutationHttpError } from "./work-http.js";

type DraftRouteServices = {
  projects: Pick<AppServices["projectRepo"], "findById">;
  fileAccess: Pick<AppServices["fileAccess"], "listAccess">;
  documentSync: Pick<
    AppServices["documentSync"],
    "draftReview" | "presses" | "drafts" | "workDrafts"
  >;
};

export function selectDraftRouteServices(app: AppServices): DraftRouteServices {
  return {
    projects: app.projectRepo,
    fileAccess: app.fileAccess,
    documentSync: app.documentSync,
  };
}

async function requireProjectOwned(
  deps: Pick<DraftRouteServices, "projects">,
  input: { projectId: ProjectId; userId: UserId },
): Promise<void> {
  const project = await deps.projects.findById(input.projectId);
  if (!project || project.userId !== input.userId || project.deletedAt) {
    throw createError({ statusCode: 404, message: "Draft not found" });
  }
}

/**
 * The draft a request names, of this project. A deleted Work's draft still reads until the Work
 * is purged, which deletes the draft: it stays picked, with Restore.
 */
/**
 * The draft, if it is this project's. A browser mints a draft id with the Work or chat it creates
 * and reads its list before the create lands, so a list answers an id not stored yet as empty
 * (`stored: false`); a press needs the stored draft.
 */
async function draftOfProject(
  deps: Pick<DraftRouteServices, "projects" | "documentSync">,
  input: { projectId: ProjectId; draft: string; userId: UserId },
): Promise<{ draft: DraftId; stored: boolean }> {
  await requireProjectOwned(deps, input);
  if (!isDraftId(input.draft)) throw createError({ statusCode: 400, message: "Invalid draft" });
  const found = await deps.documentSync.drafts.ownerOf(input.draft);
  if (found && found.draft.projectId !== input.projectId)
    throw createError({ statusCode: 404, message: "Draft not found" });
  return { draft: input.draft, stored: found !== null };
}

// --- Request bodies ----------------------------------------------------------------------------

/** A tree list's Loro version vector, decoded here once: one that isn't is a 400, and nothing downstream decodes. */
const VectorBody = z.base64().transform((value, context) => {
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  try {
    VersionVector.decode(bytes).free();
    return bytes;
  } catch {
    context.addIssue({ code: "custom", message: "Invalid version vector" });
    return z.NEVER;
  }
});
const ScopeCutBody = z.strictObject({ list: z.string().min(1).max(128), vector: VectorBody });
const SawBody = z.strictObject({
  project: ScopeCutBody.optional(),
  account: ScopeCutBody.optional(),
});
/** A shown Live version, decoded here once: one that isn't a `RoomVersion` is a 400. */
const RoomVersionBody = z.base64().transform((value, context) => {
  try {
    return decodeRoomVersion(new Uint8Array(Buffer.from(value, "base64")));
  } catch {
    context.addIssue({ code: "custom", message: "Invalid version" });
    return z.NEVER;
  }
});
const pressFields = {
  commandId: CommandIdSchema,
  saw: SawBody.optional(),
  liveVersions: z
    .array(z.strictObject({ documentId: z.string().uuid(), version: RoomVersionBody }))
    .max(2000)
    .optional(),
};
/** `PressRequest`: a verdict and the scopes it takes, so no other pair parses. */
const PressBody = z.union([
  z.strictObject({
    ...pressFields,
    verdict: z.enum(["apply", "discard"]),
    scope: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("change"),
        item: z.string().min(1).max(256),
        change: z.string().min(1).max(128),
      }),
      z.strictObject({ kind: z.literal("document"), item: z.string().min(1).max(256) }),
      z.strictObject({ kind: z.literal("draft"), draft: z.string().min(1).max(128) }),
      z.strictObject({ kind: z.literal("work"), work: z.string().uuid() }),
    ]),
  }),
  z.strictObject({
    ...pressFields,
    verdict: z.literal("restore"),
    scope: z.strictObject({
      kind: z.literal("turn"),
      turn: z.string().uuid(),
      draft: z.string().min(1).max(128),
    }),
  }),
]);
const PressUndoBody = z.strictObject({
  commandId: CommandIdSchema,
  pressCommandId: CommandIdSchema,
});
function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw createError({ statusCode: 400, message: `Invalid ${what} request` });
  return parsed.data;
}

// --- Reads -------------------------------------------------------------------------------------

export async function handleDraftListRequest(
  deps: DraftRouteServices,
  input: { projectId: ProjectId; draft: string; userId: UserId },
): Promise<DraftItemsResponse> {
  const { draft, stored } = await draftOfProject(deps, input);
  if (!stored) return { items: [], folders: [], saw: {} };
  const listed = await deps.documentSync.draftReview.listItems({ draft });
  // Readable in the draft's view, where its created documents are (file-access §6); a
  // document deleted live is no longer readable anywhere, but stays the draft's item.
  const readable = await deps.fileAccess.listAccess(
    { accountId: input.userId },
    listed.items.map((item) => item.documentId),
    {
      // A document the draft deletes is gone from its view; it is read where it still is.
      draftViews: new Map(
        listed.items
          .filter((item) => !item.tree?.deleted)
          .map((item) => [item.documentId, { kind: "draft" as const, draftId: draft }]),
      ),
    },
  );
  // A broken proposed placement must not erase a pending fact. Existing documents retain
  // their stable live-source authority even when the draft view cannot resolve an ancestor.
  const liveReadable = await deps.fileAccess.listAccess(
    { accountId: input.userId },
    listed.items.filter((item) => !item.isNew).map((item) => item.documentId),
  );
  const visible = listed.items.filter(
    (item) => readable.has(item.documentId) || liveReadable.has(item.documentId),
  );
  return {
    items: visible.map((item) => toWireItem(item, listed.threadTitles)),
    folders: listed.folders,
    saw: listed.saw,
  };
}

/**
 * Which active drafts in the project have changes to one live document, from any view. It
 * authorizes like the review routes: the project owner, and a read grant on the document
 * (a document the writer cannot read gets an empty answer, not a hint of its drafts).
 */
export async function handleDocumentDraftHintsRequest(
  deps: DraftRouteServices,
  input: { projectId: ProjectId; documentId: DocumentId; userId: UserId },
): Promise<DocumentDraftHintsResponse> {
  const project = await deps.projects.findById(input.projectId);
  if (!project || project.userId !== input.userId || project.deletedAt) {
    throw createError({ statusCode: 404, message: "Document not found" });
  }
  const readable = await deps.fileAccess.listAccess({ accountId: input.userId }, [
    input.documentId,
  ]);
  if (!readable.has(input.documentId)) return { items: [] };
  const drafts = await deps.documentSync.draftReview.draftsChangingDocument(input);
  return {
    items: await Promise.all(
      drafts.map(async (draft) => ({
        draftId: draft.draftId,
        itemKey: draftItemKey(draft.draftId, input.documentId),
        label: draft.originLabel,
        tree: await pendingTreeChange(deps, draft, input.documentId),
      })),
    ),
  };
}

/** What the draft's row does to the document's placement, for the draft notice on live. */
async function pendingTreeChange(
  deps: DraftRouteServices,
  draft: DocumentDraftOrigin,
  documentId: DocumentId,
): Promise<DocumentDraftHint["tree"]> {
  const resolved = await deps.documentSync.draftReview.resolveItemInDraft({
    draftId: draft.draftId,
    documentId,
  });
  const tree = resolved?.item.tree ?? null;
  if (tree?.deleted) return { deleted: true };
  const movedTo = tree?.movedFrom ? reviewContextLocation(resolved?.item.path ?? null) : null;
  return movedTo ? { movedTo } : null;
}

export function toWireItem(
  item: DraftReviewItem,
  threadTitles: ReadonlyMap<string, string>,
): DraftItem {
  return {
    draftId: item.draftId,
    itemKey: item.itemKey,
    documentId: item.documentId,
    pending: item.pending,
    liveVersion: item.liveVersion,
    changes: item.changes,
    origin: item.origin,
    isNew: item.isNew,
    binary: item.binary,
    wholeItem: item.wholeItem,
    tree: item.tree
      ? {
          ...(item.tree.movedFrom
            ? { movedFrom: reviewContextLocation(item.tree.movedFrom) ?? undefined }
            : {}),
          ...(item.tree.deleted ? { deleted: true as const } : {}),
        }
      : null,
    documentName: item.documentName,
    contextLocation: reviewContextLocation(item.path),
    actorThreads: item.actorThreadIds.map((threadId) => ({
      threadId,
      title: threadTitles.get(threadId) ?? null,
    })),
    unattributed: item.unattributed,
    updatedAt: item.updatedAt.toISOString(),
  };
}

async function callDraftReview<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (cause) {
    if (cause instanceof WorkLifecycleUnavailableError) throwWorkMutationHttpError(cause);
    throw cause;
  }
}

/**
 * The press: Apply or Discard on one change, a document, a draft or every draft of a Work, or a
 * Draft chat turn's `Restore before` in one draft, one command (`drizzle-press.ts`). It takes no per-document grant: the writer owns the project and
 * the drafts, and the press writes only those drafts' changes.
 */
export async function handlePressRequest(
  deps: DraftRouteServices,
  input: { projectId: ProjectId; userId: UserId; request: unknown },
): Promise<PressResult> {
  const { presses } = deps.documentSync;
  const { commandId, liveVersions, ...request } = parseBody(PressBody, input.request, "press");
  const { stored } = await draftOfProject(deps, {
    ...input,
    draft: await draftNamed(deps, request.scope),
  });
  if (!stored) throw createError({ statusCode: 404, message: "Draft not found" });
  const envelope = pressEnvelope(input, "press", commandId, input.request);
  const first = await deps.documentSync.draftReview.awaitCommand(envelope);
  const recorded = storedAnswer<PressResult>(first, commandId);
  if (recorded) return recorded;
  return callDraftReview(
    presses.press({
      envelope,
      request: {
        ...request,
        ...(liveVersions
          ? {
              liveVersions: new Map(
                liveVersions.map((entry) => [entry.documentId as DocumentId, entry.version]),
              ),
            }
          : {}),
      },
    }),
  );
}

/** A draft the scope names, which says whose project it is: a Work's is its default. */
async function draftNamed(deps: DraftRouteServices, scope: PressAction["scope"]): Promise<string> {
  if (scope.kind === "turn") return scope.draft;
  if (scope.kind === "change" || scope.kind === "document") {
    const item = parseDraftItemKey(scope.item);
    if (!item) throw createError({ statusCode: 400, message: "Invalid item" });
    return item.draftId;
  }
  if (scope.kind === "draft") return scope.draft;
  const [first] = await deps.documentSync.workDrafts.list(scope.work);
  if (!first) throw createError({ statusCode: 404, message: "Draft not found" });
  return first.id;
}

/** Take back one press, both halves: the press's own records say what it did. */
export async function handlePressUndoRequest(
  deps: DraftRouteServices,
  input: { projectId: ProjectId; userId: UserId; request: unknown },
): Promise<PressUndoResult> {
  const { presses } = deps.documentSync;
  await requireProjectOwned(deps, input);
  const request = parseBody(PressUndoBody, input.request, "Undo");
  const envelope = pressEnvelope(input, "unpress", request.commandId, request);
  const first = await deps.documentSync.draftReview.awaitCommand(envelope);
  const recorded = storedAnswer<PressUndoResult>(first, request.commandId);
  if (recorded) return recorded;
  return callDraftReview(presses.undo({ envelope, pressCommandId: request.pressCommandId }));
}

function pressEnvelope(
  scope: { projectId: ProjectId; userId: UserId },
  kind: "press" | "unpress",
  commandId: string,
  body: unknown,
): CommandEnvelope {
  return {
    commandId: commandId as CommandId,
    accountId: scope.userId,
    projectId: scope.projectId,
    kind,
    digest: commandDigest({
      accountId: scope.userId,
      projectId: scope.projectId,
      kind,
      selectors: {},
      body,
    }),
  };
}

/**
 * A resend's answer from what the first request left: its stored result, or null to run it.
 * The command driver reads any 2xx as the command's result, so a first request still running is
 * a 503 it sends again after, and an id stored for something else is the routes' 409.
 */
function storedAnswer<R extends { status: string }>(
  first: CommandLookup | { kind: "running" },
  commandId: string,
): R | null {
  if (first.kind === "running")
    throw createError({
      statusCode: 503,
      message: "The press is still running",
      data: { retryable: true },
    });
  const recorded = replay<R>(first, commandId as CommandId);
  if (recorded?.status === "conflict") return throwCommandConflict();
  return recorded as R | null;
}
