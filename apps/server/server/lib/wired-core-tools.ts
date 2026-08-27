/**
 * Core-tool wiring: binds runtime core tool registrations to concrete handlers
 * backed by Meridian context, collab, and thread services.
 */

import type {
  AgentEditResultCommand,
  ConcurrentEditInfo,
  ResponseCommitWriteReceipt,
  ResponseStagedCreateOutcome,
  WriteCommand,
  WriteErrorStatus,
} from "@meridian/agent-edit/integration";
import {
  agentEditResultCommand,
  type DocumentAddress,
  formatDocumentFile,
  modelResult,
  splitDocumentFile,
  WriteCommandSchema,
} from "@meridian/agent-edit/integration";
import { interruptResolvedPropsFromAnswer } from "@meridian/contracts/components";
import {
  askRequestFromAskUser,
  type MeridianError,
  meridianErrorFromStructuredToolOutput,
  meridianErrorFromTool,
  parseAskUserToolInput,
} from "@meridian/contracts/interrupt";
import type { JsonValue } from "@meridian/contracts/threads";
import type { Work, WorkReceipt, WorkReceiptState } from "@meridian/contracts/works";
import type {
  AgentEditAccess,
  CollabDrafts,
  DocumentProjectionRefresher,
  ResponseWriteFinalizer,
} from "../domains/collab/index.js";
import {
  contextPortForThread,
  resolveThreadContext,
} from "../domains/context/context-port-resolution.js";
import { MANUSCRIPT_URI } from "../domains/context/manuscript-uri.js";
import type { ContextError, ContextPort } from "../domains/context/ports/context-port.js";
import type { UnifiedContextPortFactory } from "../domains/context/unified-context-port-factory.js";
import {
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../domains/observability/index.js";
import type { ProjectPreferencesRepository } from "../domains/preferences/index.js";
import {
  createWork,
  deleteWorkTransition,
  updateWorkTransition,
  type WorkContextDelivery,
  WorkDeleteBlockedError,
  type WorkRepository,
} from "../domains/projects/index.js";
import {
  createCoreToolRegistrations,
  type InterruptToolHandlerContext,
  type ToolHandlerContext,
  type ToolRegistration,
  WorkCommandSchema,
} from "../domains/runtime/index.js";
import type {
  ThreadRepository,
  ThreadWorksRepository,
  TurnDocumentTouchRepository,
  WorkContextDeliveryRepository,
} from "../domains/threads/index.js";
import { rebindThreadWork } from "../domains/threads/index.js";

export const UNIFIED_MANUSCRIPT_URI = MANUSCRIPT_URI;

export interface ToolWiringDeps {
  threads: ThreadRepository;
  contextPorts: UnifiedContextPortFactory;
  documentSync: AgentEditAccess & DocumentProjectionRefresher & ResponseWriteFinalizer;
  responseWrites: Pick<AgentEditResponseWriteLifecycle, "trackStagedCreate">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary" | "rebindPrimary">;
  works: WorkRepository;
  preferences: ProjectPreferencesRepository;
  workContextDelivery: Pick<WorkContextDelivery, "projectChanged">;
  obligations: Pick<WorkContextDeliveryRepository, "enqueueThread">;
  drafts: Pick<CollabDrafts, "draftReview">;
  documentTouches?: TurnDocumentTouchRepository;
  eventSink: EventSink;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
}

type ToolErrorOutput = { isError: true; output: MeridianError };
type WriteToolErrorOutput = {
  isError: true;
  output: ReturnType<typeof modelResult>;
};
type DiffWriteCommand = Extract<WriteCommand, { command: "diff" }>;
type DocumentWriteCommand = Exclude<WriteCommand, DiffWriteCommand>;
type ModelDocumentWriteCommand = {
  [Command in DocumentWriteCommand as Command["command"]]: Omit<Command, "file" | "documentId"> & {
    path: string;
  };
}[DocumentWriteCommand["command"]];
type ModelWriteCommand = DiffWriteCommand | ModelDocumentWriteCommand;

type ResolvedDocumentAddress = DocumentAddress & { created?: boolean };

type ModelWork = Pick<
  Work,
  | "slug"
  | "name"
  | "goal"
  | "description"
  | "status"
  | "aiWriteMode"
  | "createdAt"
  | "updatedAt"
  | "lastActivityAt"
  | "unpushedChangeCount"
>;

type ResolvedModelContextPort = {
  port: ContextPort;
  primaryWorkId: string | null;
  workAuthorities: ReadonlyMap<string, string>;
};

export type StagedCreateCleanup = {
  responseId: string;
  port: ContextPort;
  path: string;
  documentId: string;
};

export interface AgentEditResponseWriteLifecycle {
  trackStagedCreate(input: StagedCreateCleanup): void;
  commitResponse(
    responseId: string,
    ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
    beforeTransactionCommit?: (result: ResponseWriteLifecycleCommitResult) => Promise<void>,
  ): Promise<ResponseWriteLifecycleCommitResult>;
  rollbackResponse(
    responseId: string,
    ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
  ): Promise<void>;
}

export type ResponseWriteLifecycleCommitResult =
  | {
      status: "committed";
      receipts: Array<{ documentId: string; receipt: ResponseCommitWriteReceipt }>;
      concurrentEdits: { documentId: string; concurrentEdits: ConcurrentEditInfo }[];
    }
  | { status: "draft_closed"; responseId: string; mode: "draft" };

const PROJECTION_REFRESH_COMMANDS = new Set<WriteCommand["command"]>([
  "create",
  "insert",
  "replace",
  "delete",
  "undo",
  "redo",
]);

function toolError(
  error: ContextError | ({ message: string; code?: string } & Record<string, unknown>),
): ToolErrorOutput {
  if ("code" in error && typeof error.code === "string") {
    return { isError: true, output: meridianErrorFromStructuredToolOutput(error as JsonValue) };
  }
  return { isError: true, output: meridianErrorFromTool(error.message) };
}

function writeToolError(
  command: AgentEditResultCommand,
  message: string,
  status: WriteErrorStatus = "invalid_write",
): WriteToolErrorOutput {
  return {
    isError: true,
    output: modelResult({ command, status, payload: { message } }),
  };
}

async function resolveContextPort(
  deps: ToolWiringDeps,
  threadId: string,
  responseId?: string,
): Promise<ResolvedModelContextPort | ToolErrorOutput> {
  const resolution = await resolveThreadContext(
    { threads: deps.threads, threadWorks: deps.threadWorks, works: deps.works },
    threadId,
  );
  if (!resolution) return toolError({ message: `Thread not found: ${threadId}` });
  return {
    port: contextPortForThread(deps.contextPorts, resolution, { responseId }),
    primaryWorkId: resolution.primaryWorkId,
    workAuthorities: resolution.workAuthorities,
  };
}

function modelWork(work: Work): ModelWork {
  const {
    slug,
    name,
    goal,
    description,
    status,
    aiWriteMode,
    createdAt,
    updatedAt,
    lastActivityAt,
    unpushedChangeCount,
  } = work;
  return {
    slug,
    name,
    goal,
    description,
    status,
    aiWriteMode,
    createdAt,
    updatedAt,
    lastActivityAt,
    ...(unpushedChangeCount !== undefined ? { unpushedChangeCount } : {}),
  };
}

function modelContextUri(uri: string, context: ResolvedModelContextPort): string {
  const match = /^(scratch|uploads):\/\/([^/]+)(\/.*)?$/.exec(uri);
  if (!match) return uri;
  const workId = match[2];
  const path = match[3] ?? "";
  if (workId === context.primaryWorkId) return `${match[1]}://${path.replace(/^\//, "")}`;
  const slug = [...context.workAuthorities].find(([, id]) => id === workId)?.[0];
  return slug ? `${match[1]}://@${slug}${path}` : uri;
}

function modelContextResults<T extends { uri: string }>(
  values: T[],
  context: ResolvedModelContextPort,
): T[] {
  return values.map((value) => ({ ...value, uri: modelContextUri(value.uri, context) }));
}

// Error payloads reach the model too: a canonical WorkId URI inside a
// ContextError leaks the identity the @slug grammar exists to hide.
function modelContextError(
  error: ContextError,
  context: ResolvedModelContextPort,
): ToolErrorOutput {
  return toolError(
    typeof error.uri === "string" ? { ...error, uri: modelContextUri(error.uri, context) } : error,
  );
}

function recordTouchInBackground(
  deps: ToolWiringDeps,
  documentId: string | undefined,
  ctx: ToolHandlerContext,
): void {
  if (!deps.documentTouches || !documentId) return;
  const eventSink = deps.eventSink;
  void deps.documentTouches.recordTouch(ctx.turnId, documentId).catch((error) => {
    emitEvent(eventSink, {
      level: "warn",
      source: "lib.wired-core-tools",
      name: "document_touch.failed",
      correlation: {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        runId: ctx.turnId,
      },
      payload: {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        documentId,
        ...unknownToEventPayload(error),
      },
    });
  });
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function parseWriteToolInput(input: unknown): ModelWriteCommand | WriteToolErrorOutput {
  const record = asRecord(input);
  const resultCommand = agentEditResultCommand(input);
  if (!record) return writeToolError(resultCommand, "write input must be an object");

  if (record.command === "diff") {
    const parsed = WriteCommandSchema.safeParse(record);
    if (!parsed.success) return writeToolError(resultCommand, writeSchemaError(parsed.error));
    if (parsed.data.command !== "diff") {
      return writeToolError(resultCommand, "Invalid diff command");
    }
    return parsed.data;
  }

  const { path, ...packageInput } = record;
  if (typeof path !== "string" || path.length === 0) {
    return writeToolError(resultCommand, "path is required");
  }

  const parsed = WriteCommandSchema.safeParse({ ...packageInput, file: path });
  if (!parsed.success) return writeToolError(resultCommand, writeSchemaError(parsed.error));

  if (parsed.data.command === "diff") {
    return writeToolError(resultCommand, "diff does not accept path");
  }
  const { file: _file, documentId: _documentId, tool_use_id: _toolUseId, ...command } = parsed.data;
  return { ...command, path } as ModelWriteCommand;
}

function writeSchemaError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map((part) => (part === "file" ? "path" : part)).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

function schemaError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

function receiptState(work: Work): WorkReceiptState {
  return {
    name: work.name,
    goal: work.goal,
    description: work.description,
    status: work.status,
  };
}

async function workBySlug(
  deps: ToolWiringDeps,
  projectId: string,
  slug: string,
): Promise<Awaited<ReturnType<WorkRepository["findById"]>> | ToolErrorOutput> {
  const works = await deps.works.listByProject(projectId);
  const work = works.find((candidate) => candidate.slug === slug) ?? null;
  if (work) return work;
  const validWorkSlugs = works.map((candidate) => candidate.slug);
  return toolError({
    code: "work_not_found",
    message: `Unknown Work ${slug}. Valid Work slugs: ${validWorkSlugs.join(", ") || "none"}`,
    workSlug: slug,
    validWorkSlugs,
  });
}

function cleared(value: string | undefined): string | null | undefined {
  return value === "" ? null : value;
}

function isToolError(value: unknown): value is ToolErrorOutput | WriteToolErrorOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    "isError" in value &&
    (value as { isError?: boolean }).isError === true
  );
}

async function resolveDocumentAddress(
  context: ResolvedModelContextPort,
  input: ModelDocumentWriteCommand,
  options: { deferTrackedDocumentSync?: boolean } = {},
): Promise<ResolvedDocumentAddress | WriteToolErrorOutput> {
  const port = context.port;
  const { filePath: basePath, fragment } = splitDocumentFile(input.path);
  if (input.command === "create") {
    if (fragment)
      return writeToolError(input.command, "create does not accept a #fragment in path");
    const ensured = await port.ensureTrackedDocument(
      basePath,
      options.deferTrackedDocumentSync ? { deferDocumentSync: true } : undefined,
    );
    if (!ensured.ok) {
      return writeToolError(input.command, modelContextErrorMessage(ensured.error, context));
    }
    return {
      documentId: ensured.value.documentId,
      filePath: basePath,
      ...(fragment === undefined ? {} : { fragment }),
      created: ensured.value.created,
    };
  }

  const ref = await port.stat(basePath);
  if (!ref.ok) {
    return writeToolError(
      input.command,
      modelContextErrorMessage(ref.error, context),
      ref.error.code === "not_found" ? "document_not_found" : "invalid_write",
    );
  }
  if (ref.value.kind !== "tracked") {
    return writeToolError(input.command, `Cannot ${input.command} binary file: ${input.path}`);
  }
  if (!ref.value.documentId) {
    return writeToolError(input.command, `Document id missing for ${input.path}`);
  }
  return {
    documentId: ref.value.documentId,
    filePath: basePath,
    ...(fragment === undefined ? {} : { fragment }),
  };
}

function modelContextErrorMessage(error: ContextError, context: ResolvedModelContextPort): string {
  return contextErrorMessage(
    typeof error.uri === "string" ? { ...error, uri: modelContextUri(error.uri, context) } : error,
  );
}

function contextErrorMessage(error: ContextError): string {
  if ("message" in error && typeof error.message === "string") return error.message;
  return `${error.code}: ${error.uri}`;
}

async function deleteCreatedTrackedDocument(input: {
  port: ContextPort;
  path: string;
  documentId: string;
}): Promise<void> {
  const ref = await input.port.stat(input.path);
  if (!ref.ok) {
    if (ref.error.code === "not_found") return;
    throw new Error(contextErrorMessage(ref.error));
  }
  if (ref.value.kind !== "tracked" || ref.value.documentId !== input.documentId) return;

  const deleted = await input.port.delete(input.path);
  if (!deleted.ok && deleted.error.code !== "not_found") {
    throw new Error(contextErrorMessage(deleted.error));
  }
}

function buildAgentWriteCommand(
  input: ModelWriteCommand,
  address: ResolvedDocumentAddress,
  toolUseId: string | undefined,
): WriteCommand {
  if (input.command === "diff") return input;
  const { path: _path, ...command } = input;
  return {
    ...command,
    documentId: address.documentId,
    file: formatDocumentFile(address),
    tool_use_id: toolUseId,
  } as WriteCommand;
}

async function refreshProjectionAfterToolWrite(
  deps: Pick<ToolWiringDeps, "documentSync">,
  documentId: string,
  ctx: Pick<ToolHandlerContext, "threadId">,
): Promise<void> {
  await deps.documentSync.refreshDocumentProjection({
    documentId,
    threadId: ctx.threadId,
  });
}

export function createAgentEditResponseWriteLifecycle(
  deps: Pick<ToolWiringDeps, "documentSync">,
): AgentEditResponseWriteLifecycle {
  const stagedCreates = new Map<string, StagedCreateCleanup[]>();

  async function cleanupDiscardedStagedCreates(
    responseId: string,
    discardedDocumentIds: ResponseStagedCreateOutcome["discarded"],
  ): Promise<void> {
    const records = stagedCreates.get(responseId) ?? [];
    const discarded = new Set(discardedDocumentIds);
    for (const record of records) {
      if (!discarded.has(record.documentId)) continue;
      await deleteCreatedTrackedDocument(record);
    }
  }

  return {
    trackStagedCreate(input: StagedCreateCleanup): void {
      const records = stagedCreates.get(input.responseId) ?? [];
      if (
        !records.some(
          (record) => record.path === input.path && record.documentId === input.documentId,
        )
      ) {
        records.push(input);
      }
      stagedCreates.set(input.responseId, records);
    },

    async commitResponse(
      responseId: string,
      ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
      beforeTransactionCommit?: (result: ResponseWriteLifecycleCommitResult) => Promise<void>,
    ): Promise<ResponseWriteLifecycleCommitResult> {
      const mapResult = (
        result: Awaited<ReturnType<typeof deps.documentSync.finalizeResponseCommit>>,
      ): ResponseWriteLifecycleCommitResult => {
        if (result.status === "draft_closed") {
          return { status: result.status, responseId: result.responseId, mode: result.mode };
        }
        return {
          status: "committed",
          receipts: result.documents.flatMap((document) =>
            document.receipts.map((receipt) => ({ documentId: document.documentId, receipt })),
          ),
          concurrentEdits: result.documents.flatMap((document) =>
            document.concurrentEdits
              ? [{ documentId: document.documentId, concurrentEdits: document.concurrentEdits }]
              : [],
          ),
        };
      };
      const result = await deps.documentSync.finalizeResponseCommit(
        responseId,
        ctx,
        async (commitResult) => beforeTransactionCommit?.(mapResult(commitResult)),
      );
      await cleanupDiscardedStagedCreates(responseId, result.stagedCreates.discarded);
      stagedCreates.delete(responseId);
      return mapResult(result);
    },

    async rollbackResponse(
      responseId: string,
      ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
    ): Promise<void> {
      const result = await deps.documentSync.finalizeResponseRollback(responseId, ctx);
      try {
        await cleanupDiscardedStagedCreates(responseId, result.stagedCreates.discarded);
      } finally {
        stagedCreates.delete(responseId);
      }
    },
  };
}

async function askUserHandler(input: unknown, ctx: InterruptToolHandlerContext) {
  const parsed = parseAskUserToolInput(input);
  if (!parsed.ok) return toolError({ message: parsed.message });

  const args = parsed.value;
  const timeoutMs = args.timeoutMs ?? ctx.interruptTimeoutMs;
  const request = askRequestFromAskUser(args, crypto.randomUUID());

  const response = await ctx.interrupt(request, timeoutMs);
  const resolvedProps = interruptResolvedPropsFromAnswer(response);
  await ctx.updateComponentBlock(request.interruptId, resolvedProps);
  return { value: resolvedProps.resolvedValue, provenance: response.provenance };
}

export function createWiredCoreToolRegistrations(deps: ToolWiringDeps): ToolRegistration[] {
  return createCoreToolRegistrations({
    work: async (input: unknown, ctx: ToolHandlerContext) => {
      const parsed = WorkCommandSchema.safeParse(input);
      if (!parsed.success) return toolError({ message: schemaError(parsed.error) });
      const command = parsed.data;
      const thread = await deps.threads.findById(ctx.threadId);
      if (!thread) return toolError({ message: `Thread not found: ${ctx.threadId}` });

      try {
        if (command.command === "list") {
          const works = await deps.works.listByProject(thread.projectId, {
            status: command.status ?? "active",
          });
          return works.map(modelWork);
        }

        if (command.command === "create") {
          const previousCurrentWorkId = await deps.preferences.getCurrentWorkId(
            thread.userId,
            thread.projectId,
          );
          const work = await createWork(
            {
              works: deps.works,
              preferences: deps.preferences,
              workContextDelivery: deps.workContextDelivery,
            },
            thread.userId,
            {
              projectId: thread.projectId,
              createdByUserId: thread.userId,
              name: command.name,
              goal: command.goal,
              description: command.description,
            },
          );
          return {
            output: modelWork(work),
            metadata: {
              workReceipt: {
                operation: "create",
                category: "mutate",
                changed: true,
                workId: work.id,
                workName: work.name,
                before: null,
                after: receiptState(work),
                inverse: { command: "delete", workId: work.id, previousCurrentWorkId },
              } satisfies WorkReceipt,
              workContextChanged: true,
            },
          };
        }

        const selected = await workBySlug(deps, thread.projectId, command.work);
        if (isToolError(selected)) return selected;
        if (!selected) return toolError({ message: `Unknown Work ${command.work}` });

        if (command.command === "show") {
          const [threads, drafts] = await Promise.all([
            deps.threads.listByWork(thread.projectId, selected.id),
            deps.drafts.draftReview.list({ projectId: thread.projectId, workId: selected.id }),
          ]);
          return {
            work: modelWork(selected),
            recentThreads: threads.slice(0, 10).map(({ title, updatedAt, status }) => ({
              title,
              updatedAt,
              status,
            })),
            drafts: drafts.map(({ workId: _workId, ...draft }) => draft),
          };
        }

        if (command.command === "update") {
          const transition = await updateWorkTransition(
            { works: deps.works, workContextDelivery: deps.workContextDelivery },
            selected.id,
            {
              name: command.name,
              goal: cleared(command.goal),
              description: cleared(command.description),
              status: command.status,
            },
          );
          const { before, after: updated, changed } = transition;
          return {
            output: modelWork(updated),
            metadata: {
              workReceipt: {
                operation: "update",
                category: "mutate",
                changed,
                workId: updated.id,
                workName: updated.name,
                before: receiptState(before),
                after: receiptState(updated),
                inverse: changed
                  ? { command: "update", workId: before.id, state: receiptState(before) }
                  : null,
              } satisfies WorkReceipt,
              ...(before.name !== updated.name ||
              before.goal !== updated.goal ||
              before.status !== updated.status
                ? { workContextChanged: true }
                : {}),
            },
          };
        }

        if (command.command === "delete") {
          const transition = await deleteWorkTransition(
            { works: deps.works, workContextDelivery: deps.workContextDelivery },
            selected.id,
          );
          const before = transition.before ?? selected;
          const deleted = transition.after ?? before;
          return {
            output: modelWork(deleted),
            metadata: {
              workReceipt: {
                operation: "delete",
                category: "mutate",
                changed: transition.changed,
                workId: before.id,
                workName: before.name,
                before: receiptState(before),
                after: null,
                inverse: transition.changed ? { command: "restore", workId: before.id } : null,
              } satisfies WorkReceipt,
              ...(transition.changed ? { workContextChanged: true } : {}),
            },
          };
        }

        const rebound = await deps.transaction(() =>
          rebindThreadWork(
            {
              threads: deps.threads,
              threadWorks: deps.threadWorks,
              works: deps.works,
              preferences: deps.preferences,
              obligations: deps.obligations,
            },
            {
              threadId: thread.id,
              targetWorkId: selected.id,
              preferenceUserId: thread.userId,
            },
          ),
        );
        return {
          output: modelWork(rebound.work),
          metadata: {
            workReceipt: rebound.receipt,
            ...(rebound.changed ? { workContextChanged: true } : {}),
          },
        };
      } catch (error) {
        if (error instanceof WorkDeleteBlockedError) {
          return toolError({
            code: "work_delete_blocked",
            message: error.message,
            blockingContentKind: error.reason,
          });
        }
        return toolError({ message: error instanceof Error ? error.message : String(error) });
      }
    },
    write: async (input: unknown, ctx: ToolHandlerContext) => {
      const parsed = parseWriteToolInput(input);
      if (isToolError(parsed)) return parsed;

      if (parsed.command === "diff") {
        const outcome = await deps.documentSync.agentEdit().write(parsed, {
          sessionId: ctx.threadId,
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          responseId: ctx.responseId,
          tool_use_id: ctx.toolCallId,
        });
        return outcome.isError
          ? { isError: true, output: outcome.result }
          : { output: outcome.result };
      }

      const portOrError = await resolveContextPort(deps, ctx.threadId, ctx.responseId);
      if ("isError" in portOrError) {
        return writeToolError(parsed.command, portOrError.output.message);
      }

      const address = await resolveDocumentAddress(portOrError, parsed, {
        deferTrackedDocumentSync: parsed.command === "create" && ctx.responseId !== undefined,
      });
      if (isToolError(address)) return address;

      const outcome = await deps.documentSync
        .agentEdit()
        .write(buildAgentWriteCommand(parsed, address, ctx.toolCallId), {
          sessionId: ctx.threadId,
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          responseId: ctx.responseId,
          tool_use_id: ctx.toolCallId,
          createdDocument: address.created === true,
        });
      const stagedCreate =
        parsed.command === "create" && ctx.responseId !== undefined && address.created === true;
      if (outcome.isError) {
        if (stagedCreate) {
          try {
            await deleteCreatedTrackedDocument({
              port: portOrError.port,
              path: parsed.path,
              documentId: address.documentId,
            });
          } catch (error) {
            return writeToolError(
              parsed.command,
              `Failed to discard staged create for ${parsed.path}: ${
                error instanceof Error ? error.message : String(error)
              }`,
              "internal_error",
            );
          }
        }
        return { isError: true, output: outcome.result };
      }
      if (stagedCreate) {
        const responseId = ctx.responseId;
        if (responseId === undefined) {
          return writeToolError(parsed.command, "Missing staged response id", "internal_error");
        }
        deps.responseWrites.trackStagedCreate({
          responseId,
          port: portOrError.port,
          path: parsed.path,
          documentId: address.documentId,
        });
      }

      recordTouchInBackground(deps, address.documentId, ctx);
      const stagedWrite =
        ctx.responseId !== undefined &&
        (parsed.command === "create" ||
          parsed.command === "insert" ||
          parsed.command === "replace" ||
          parsed.command === "delete");
      if (PROJECTION_REFRESH_COMMANDS.has(parsed.command) && !stagedWrite) {
        await refreshProjectionAfterToolWrite(deps, address.documentId, ctx);
      }
      return {
        output: outcome.result,
        ...(stagedWrite
          ? {
              metadata: {
                documentId: address.documentId,
                stagedWrite: true,
                ...(outcome.writeId ? { writeId: outcome.writeId } : {}),
                ...(outcome.settlementId ? { settlementId: outcome.settlementId } : {}),
              },
            }
          : {}),
      };
    },
    ls: async (input: unknown, ctx: ToolHandlerContext) => {
      const { path } = (input ?? {}) as { path?: string };
      const portOrError = await resolveContextPort(deps, ctx.threadId, ctx.responseId);
      if ("isError" in portOrError) return portOrError;
      const result = await portOrError.port.list(path);
      if (!result.ok) return modelContextError(result.error, portOrError);
      return modelContextResults(result.value, portOrError);
    },
    search: async (input: unknown, ctx: ToolHandlerContext) => {
      const { pattern, scope } = input as { pattern?: string; scope?: string };
      if (!pattern) return toolError({ message: "pattern is required" });
      const portOrError = await resolveContextPort(deps, ctx.threadId, ctx.responseId);
      if ("isError" in portOrError) return portOrError;
      const result = await portOrError.port.search(pattern, scope);
      if (!result.ok) return modelContextError(result.error, portOrError);
      return modelContextResults(result.value, portOrError);
    },
    ask_user: askUserHandler,
  });
}
