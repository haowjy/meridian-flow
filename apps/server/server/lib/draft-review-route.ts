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
import {
  type CommandEnvelope,
  type CommandLookup,
  commandDigest,
  replay,
} from "../shared/commands/command-record.js";
import { WorkLifecycleUnavailableError } from "../shared/work-lifecycle-lock.js";
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
      z.strictObject({
        kind: z.literal("work"),
        work: z.string().uuid(),
        drafts: z.array(z.string().min(1).max(128)).min(1).max(200),
      }),
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

export async function handleDraftListRequest(
  deps: DraftRouteServices,
  input: { projectId: ProjectId; draft: string; userId: UserId },
): Promise<DraftItemsResponse> {
  const { draft, stored } = await draftOfProject(deps, input);
  if (!stored) return { items: [], folders: [], saw: {} };
  const listed = await deps.documentSync.draftReview.listItems({ draft });
  const readable = await deps.fileAccess.listAccess(
    { accountId: input.userId },
    listed.items.map((item) => item.documentId),
    {
      draftViews: new Map(
        listed.items
          .filter((item) => !item.tree?.deleted)
          .map((item) => [item.documentId, { kind: "draft" as const, draftId: draft }]),
      ),
    },
  );
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
    changeCount: item.changeCount,
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
