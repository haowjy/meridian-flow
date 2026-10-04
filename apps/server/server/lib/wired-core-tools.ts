/**
 * Core-tool wiring: binds runtime core tool registrations to concrete handlers
 * backed by Meridian context, collab, and thread services.
 */

import type {
  AgentEditResultCommand,
  ConcurrentEditInfo,
  DocumentCommandName,
  DocumentVersion,
  ReadToolInput,
  ResponseCommitWriteReceipt,
  ResponseStagedCreateOutcome,
  WriteCommand,
  WriteErrorStatus,
  WriteOutcome,
  WriteToolInput,
} from "@meridian/agent-edit/integration";
import {
  type DocumentAddress,
  documentNotFoundMessage,
  formatDocumentFile,
  modelResult,
  splitDocumentFile,
} from "@meridian/agent-edit/integration";
import {
  type AskUserToolInput,
  interruptResolvedPropsFromAnswer,
} from "@meridian/contracts/components";
import {
  askRequestFromAskUser,
  type MeridianError,
  meridianErrorFromStructuredToolOutput,
  meridianErrorFromTool,
} from "@meridian/contracts/interrupt";
import type {
  DocumentRevisionEvidence,
  PermissionDeniedReason,
} from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import type {
  ThreadExecutionContext,
  Work,
  WorkReceipt,
  WorkReceiptState,
} from "@meridian/contracts/works";
import { workLifecycleState } from "@meridian/contracts/works";
import type {
  AgentEditAccess,
  AgentEditDestination,
  CollabDrafts,
  DocumentProjectionRefresher,
  ResponseWriteFinalizer,
} from "../domains/collab/index.js";
import { copyBinaryDocument } from "../domains/context/binary-copy.js";
import { unknownWorkMessage } from "../domains/context/context/router.js";
import {
  contextPortForThread,
  resolveThreadContext,
  type ThreadContextResolution,
} from "../domains/context/context-port-resolution.js";
import type { CopiedFrom, DocumentCreationMetadata } from "../domains/context/document-metadata.js";
import { MANUSCRIPT_URI } from "../domains/context/manuscript-uri.js";
import type {
  BinaryFileRef,
  ContextError,
  ContextPort,
  FileEntry,
  FileRef,
} from "../domains/context/ports/context-port.js";
import type { UnifiedContextPortFactory } from "../domains/context/unified-context-port-factory.js";
import {
  type AgentChain,
  type FileAccess,
  type FileAccessDenied,
  FileEditRefusedError,
  type FileGrant,
  type FileNeed,
  type FileTarget,
  isFileAccessDenied,
  type Principal,
  runWithEditGrants,
} from "../domains/file-policy/index.js";
import {
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../domains/observability/index.js";
import {
  createWork,
  deleteWorkTransition,
  setWorkArchived,
  updateWorkTransition,
  type WorkContextNotices,
  WorkLifecycleUnavailableError,
  WorkNameRequiredError,
  type WorkRepository,
  WorkStatusInvalidError,
} from "../domains/projects/index.js";
import {
  actionPolicy,
  createCoreToolRegistrations,
  type InterruptToolHandlerContext,
  type LsToolInput,
  type ReferenceReader,
  type SearchToolInput,
  type ToolHandlerContext,
  type ToolRegistration,
  type WorkCommand,
  workActionRefusal,
} from "../domains/runtime/index.js";
import type { ObjectStorePort } from "../domains/storage/index.js";
import type {
  ThreadRepository,
  ThreadWorksRepository,
  TurnDocumentTouchRepository,
} from "../domains/threads/index.js";
import {
  RebindThreadWorkError,
  rebindThreadWork,
  threadExecutionContext,
} from "../domains/threads/index.js";
import { isPermissionDenial, permissionDeniedMessage } from "./file-access-denial-copy.js";
import { threadContainerTarget } from "./file-targets.js";

export const UNIFIED_MANUSCRIPT_URI = MANUSCRIPT_URI;

export interface ToolWiringDeps {
  threads: ThreadRepository;
  contextPorts: UnifiedContextPortFactory;
  documentSync: AgentEditAccess & DocumentProjectionRefresher & ResponseWriteFinalizer;
  responseWrites: Pick<AgentEditResponseWriteLifecycle, "trackStagedCreate">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary" | "rebindPrimary">;
  works: WorkRepository;
  workAuthorityResolver: import("../domains/projects/index.js").ProjectWorkAuthorityResolver;
  workContextNotices: Pick<WorkContextNotices, "workChanged" | "threadChanged">;
  stopThreadRun(threadId: ThreadId): Promise<void>;
  drafts: Pick<CollabDrafts, "draftReview">;
  documentTouches?: TurnDocumentTouchRepository;
  eventSink: EventSink;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  /** Binary copies duplicate the stored object (D24). */
  objectStore: ObjectStorePort;
  /** Every model read and write asks the file policy first (file-access §1). */
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit" | "listAccess">;
  /** The calling thread's delegation chain, read fresh per call (file-access §8). */
  readAgentChain(threadId: ThreadId): Promise<AgentChain>;
}

type ToolErrorOutput = { isError: true; output: MeridianError };
type WriteToolErrorOutput = {
  isError: true;
  output: ReturnType<typeof modelResult>;
};
type ResolvedDocumentAddress = DocumentAddress & { uri: string; created?: boolean };

type ModelWork = Pick<
  Work,
  | "slug"
  | "name"
  | "goal"
  | "status"
  | "archivedAt"
  | "aiWriteMode"
  | "createdAt"
  | "updatedAt"
  | "lastActivityAt"
  | "unpushedChangeCount"
>;

type ResolvedModelContextPort = {
  resolution: ThreadContextResolution;
  port: ContextPort;
  /** The same thread's port with every write live, whatever the Work's mode. */
  livePort: () => ContextPort;
  primaryWorkId: string | null;
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
      /** Documents the save left out, with the copy their writes' results now carry (D29). */
      refused: Array<{ documentId: string; message: string; reason?: PermissionDeniedReason }>;
    }
  | { status: "draft_closed"; responseId: string; mode: "draft" };

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
  payload: { path?: string } = {},
): WriteToolErrorOutput {
  return {
    isError: true,
    output: modelResult({ command, status, payload: { ...payload, message } }),
  };
}

async function resolveContextPort(
  deps: ToolWiringDeps,
  threadId: string,
  responseId?: string,
  version?: DocumentVersion,
): Promise<ResolvedModelContextPort | ToolErrorOutput> {
  const resolution = await resolveThreadContext(
    {
      threads: deps.threads,
      threadWorks: deps.threadWorks,
      works: deps.works,
      workAuthorityResolver: deps.workAuthorityResolver,
    },
    threadId,
  );
  if (!resolution) return toolError({ message: `Thread not found: ${threadId}` });
  return {
    resolution,
    port: contextPortForThread(deps.contextPorts, resolution, {
      responseId,
      ...(version ? { version } : {}),
    }),
    livePort: () =>
      contextPortForThread(deps.contextPorts, resolution, { responseId, liveWrites: true }),
    primaryWorkId: resolution.primaryWorkId,
  };
}

async function resolveExecutionContext(
  deps: ToolWiringDeps,
  threadId: string,
): Promise<ThreadExecutionContext | ToolErrorOutput> {
  const primary = await deps.threadWorks.findPrimary(threadId);
  if (!primary) throw new Error(`Thread primary Work is missing: ${threadId}`);
  const work = await deps.works.findById(primary.workId);
  if (!work || workLifecycleState(work) === "deleted") {
    return toolError({ code: "work_unavailable", message: "The current Work is unavailable" });
  }
  return threadExecutionContext(work);
}

function modelWork(work: Work): ModelWork {
  const {
    slug,
    name,
    goal,
    status,
    archivedAt,
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
    status,
    archivedAt,
    aiWriteMode,
    createdAt,
    updatedAt,
    lastActivityAt,
    ...(unpushedChangeCount !== undefined ? { unpushedChangeCount } : {}),
  };
}

function modelContextUri(uri: string, context: ResolvedModelContextPort): string {
  void context;
  return uri;
}

function modelContextResults<T extends { uri: string }>(
  values: T[],
  context: ResolvedModelContextPort,
): T[] {
  return values.map((value) => ({ ...value, uri: modelContextUri(value.uri, context) }));
}

// Error payloads reach the model through the same canonical URI boundary.
function modelContextError(
  error: ContextError,
  context: ResolvedModelContextPort,
): ToolErrorOutput {
  const details =
    typeof error.uri === "string" ? { ...error, uri: modelContextUri(error.uri, context) } : error;
  // The message is the readable reason; the error itself rides in `details`, not re-encoded.
  return toolError({ code: error.code, message: contextErrorMessage(details), details });
}

function recordTouchInBackground(
  deps: ToolWiringDeps,
  documentId: string | undefined,
  ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
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

function receiptState(work: Work): WorkReceiptState {
  return {
    name: work.name,
    goal: work.goal,
    status: work.status,
    archived: work.archivedAt !== null,
  };
}

async function workBySlug(
  deps: ToolWiringDeps,
  projectId: string,
  slug: string,
): Promise<Work | ToolErrorOutput> {
  const works = await deps.works.listByProject(projectId, { lifecycle: "all" });
  const work = works.find((candidate) => candidate.slug === slug);
  if (work) return work;
  return toolError({ code: "work_not_found", message: unknownWorkMessage(slug), workSlug: slug });
}

/**
 * The Work a `switch` names. An unknown Work points to `work list` (D51), an
 * archived one can't be switched to by anyone, and the chat's current Work
 * needs no switch.
 */
async function resolveSwitchTarget(
  deps: ToolWiringDeps,
  projectId: string,
  threadId: ThreadId,
  slug: string | null | undefined,
): Promise<{ work: Work } | { unchanged: { message: string } } | ToolErrorOutput> {
  let work: Work;
  if (slug) {
    const found = await workBySlug(deps, projectId, slug);
    if (isToolError(found)) return found;
    if (workLifecycleState(found) === "deleted") {
      return toolError({
        code: "work_not_found",
        message: unknownWorkMessage(slug),
        workSlug: slug,
      });
    }
    work = found;
  } else {
    const noWork = await deps.works.findNoWork(projectId);
    if (!noWork) return toolError({ message: "No Work is missing for this project" });
    work = noWork;
  }
  const named = work.slug ? `@${work.slug}` : "No Work";
  if (workLifecycleState(work) === "archived") {
    return toolError({
      code: "work_archived",
      message: `Work ${named} is archived, so this chat can't switch to it until the user unarchives it.`,
    });
  }
  const current = await deps.threadWorks.findPrimary(threadId);
  const currentId = current?.workId ?? (work.isNoWork ? work.id : null);
  if (currentId === work.id) return { unchanged: { message: `This chat is already in ${named}.` } };
  return { work };
}

function isToolError(value: unknown): value is ToolErrorOutput | WriteToolErrorOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    "isError" in value &&
    (value as { isError?: boolean }).isError === true
  );
}

/** Resolves a model path to its tracked document; only `create` may make one. */
async function resolveDocumentAddress(
  context: ResolvedModelContextPort,
  command: DocumentCommandName,
  path: string,
  options: { deferTrackedDocumentSync?: boolean; metadata?: DocumentCreationMetadata } = {},
): Promise<ResolvedDocumentAddress | WriteToolErrorOutput> {
  const port = context.port;
  const { filePath: basePath, fragment } = splitDocumentFile(path);
  if (command === "create" || command === "copy") {
    if (fragment) return writeToolError(command, `${command} does not accept a #fragment in path`);
    const ensureOptions = {
      ...(options.deferTrackedDocumentSync ? { deferDocumentSync: true } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    };
    const ensured = await port.ensureTrackedDocument(
      basePath,
      Object.keys(ensureOptions).length > 0 ? ensureOptions : undefined,
    );
    if (!ensured.ok) {
      return writeToolError(command, modelContextErrorMessage(ensured.error, context));
    }
    return {
      documentId: ensured.value.documentId,
      uri: ensured.value.uri,
      filePath: basePath,
      created: ensured.value.created,
    };
  }

  const ref = await port.stat(basePath);
  if (!ref.ok) {
    if (ref.error.code === "not_found") {
      return writeToolError(command, documentNotFoundMessage(command), "document_not_found", {
        path,
      });
    }
    // A URI naming no Work or no scheme addresses no document; the reason lists the valid ones.
    const unknownAddress =
      ref.error.code === "invalid_uri" &&
      (ref.error.workSlug !== undefined || ref.error.unknownScheme !== undefined);
    return writeToolError(
      command,
      modelContextErrorMessage(ref.error, context),
      unknownAddress ? "document_not_found" : "invalid_write",
      unknownAddress ? { path } : {},
    );
  }
  if (ref.value.kind !== "tracked") {
    return writeToolError(
      command,
      command === "read"
        ? "The file is binary, so it can't be read as text."
        : "The file is binary, so it can't be edited as text.",
      "binary_file",
      { path },
    );
  }
  if (!ref.value.documentId) {
    return writeToolError(command, `Document id missing for ${path}`);
  }
  return {
    documentId: ref.value.documentId,
    uri: ref.value.uri,
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
  if (error.code === "context_unavailable") {
    // The file policy refuses an archived Work's files first, with copy fit for
    // the agent; this storage-side refusal only follows an archive mid-call.
    const work = error.workSlug ? `Work @${error.workSlug}` : "The requested Work";
    return error.reason === "work_archived"
      ? `${work} is archived, so this change wasn't made.`
      : `${work} is unavailable.`;
  }
  if (error.code === "invalid_uri") return error.reason;
  if ("message" in error && typeof error.message === "string") return error.message;
  return `${error.code}: ${error.uri}`;
}

/**
 * The agent a tool call acts as (file-access §8): the thread's person, its
 * delegation chain read fresh, and the Work whose draft its drafted writes
 * land in.
 */
async function agentPrincipal(
  deps: Pick<ToolWiringDeps, "readAgentChain">,
  context: ResolvedModelContextPort,
  execution: ThreadExecutionContext,
): Promise<Principal> {
  const thread = context.resolution.thread;
  return {
    accountId: thread.userId as Principal["accountId"],
    agent: {
      chain: await deps.readAgentChain(thread.id as ThreadId),
      draftWork: execution.draftOwner
        ? { id: execution.draftOwner.workId, slug: execution.scope.workSlug }
        : null,
    },
  };
}

/** The file policy's grant on a document; a denial comes back as the tool's error. */
async function documentGrant<N extends FileNeed>(
  deps: Pick<ToolWiringDeps, "fileAccess">,
  principal: Principal,
  command: DocumentCommandName,
  address: Pick<ResolvedDocumentAddress, "documentId" | "filePath">,
  need: N,
): Promise<FileGrant<N> | WriteToolErrorOutput> {
  const grant = await deps.fileAccess.authorize(
    principal,
    { kind: "document", documentId: address.documentId as never },
    need,
  );
  return isFileAccessDenied(grant)
    ? fileAccessDeniedError(command, grant, address.filePath)
    : grant;
}

/** Where a create or copy makes its file; null when the path names no Work. */
function containerTarget(
  deps: Pick<ToolWiringDeps, "works">,
  context: ResolvedModelContextPort,
  path: string,
): Promise<FileTarget | null> {
  return threadContainerTarget(deps.works, context.resolution, path);
}

/** A refused grant as the tool's error: `permission_denied` with its reason (§9). */
function fileAccessDeniedError(
  command: DocumentCommandName,
  denial: FileAccessDenied,
  path?: string,
): WriteToolErrorOutput {
  if (!isPermissionDenial(denial)) {
    return writeToolError(
      command,
      documentNotFoundMessage(command),
      "document_not_found",
      path ? { path } : {},
    );
  }
  return {
    isError: true,
    output: modelResult({
      command,
      status: "permission_denied",
      payload: {
        ...(path ? { path } : {}),
        reason: denial.reason,
        message: permissionDeniedMessage(denial),
      },
    }),
  };
}

/** Why the reply's save left out a document's changes (D29, D42). */
function refusedAtSave(denial: FileAccessDenied): {
  message: string;
  reason?: PermissionDeniedReason;
} {
  if (!isPermissionDenial(denial)) {
    return {
      message: "This file was deleted before this reply was saved, so this change wasn't saved.",
    };
  }
  return { message: permissionDeniedMessage(denial), reason: denial.reason };
}

/**
 * A `work` command on an archived or gone Work. Offers the unarchive call only
 * when the action policy would allow it.
 */
function workLifecycleMessage(
  reason: "work_archived" | "work_deleted" | "work_missing",
  workSlug: string | null,
  mayUnarchive: boolean,
): string {
  if (reason !== "work_archived") {
    return workSlug ? `Work @${workSlug} is unavailable.` : "The requested Work is unavailable.";
  }
  if (!workSlug) return "The requested Work is archived and read-only.";
  return mayUnarchive
    ? `Work @${workSlug} is archived and read-only. Unarchive it with \`work({"command":"unarchive","work":"${workSlug}"})\` before changing it.`
    : `Work @${workSlug} is archived and read-only. Ask the user to unarchive @${workSlug}.`;
}

async function deleteCreatedTrackedDocument(input: {
  port: ContextPort;
  path: string;
  documentId: string;
}): Promise<void> {
  const deleted = await input.port.delete(input.path, {
    expected: { kind: "file", documentId: input.documentId },
  });
  if (!deleted.ok && deleted.error.code !== "not_found" && deleted.error.code !== "stale_target") {
    throw new Error(contextErrorMessage(deleted.error));
  }
}

function buildAgentWriteCommand(
  input: WriteToolInput,
  address: ResolvedDocumentAddress,
  toolUseId: string | undefined,
): WriteCommand {
  const { path: _path, ...command } = input;
  return {
    ...command,
    documentId: address.documentId,
    file: formatDocumentFile(address),
    tool_use_id: toolUseId,
  };
}

/** Which blocks a read renders, as the `read` tool's selector fields. */
type ReadSelection = Pick<ReadToolInput, "in" | "around">;

/** Writes report where they landed; a drafted write names its Work. */
function withDestination(outcome: WriteOutcome, destination: AgentEditDestination): WriteOutcome {
  if (outcome.isError) return outcome;
  return {
    ...outcome,
    result: {
      ...outcome.result,
      destination: destination.kind,
      ...(destination.kind === "draft" ? { draftWork: destination.workSlug ?? "/" } : {}),
    },
  };
}

/**
 * The one server read path (D18). The `read` tool's handler and reference
 * loading both call it; nothing builds tool arguments to reach it. Omitted
 * `version` reads where this thread's writes go; `live` never touches a
 * draft (D3, D14).
 */
async function readDocument(
  deps: Pick<ToolWiringDeps, "documentSync">,
  grant: FileGrant,
  address: ResolvedDocumentAddress,
  options: {
    selection?: ReadSelection;
    format?: ReadToolInput["format"];
    version?: DocumentVersion;
    /** A copy's source read also returns the selected blocks as nodes. */
    includeNodes?: boolean;
  },
  ctx: Pick<ToolHandlerContext, "threadId" | "turnId" | "responseId" | "toolCallId">,
): Promise<WriteOutcome> {
  return deps.documentSync.agentEdit().read(
    {
      ...options.selection,
      ...(options.format ? { format: options.format } : {}),
      file: formatDocumentFile(address),
      documentId: address.documentId,
    },
    {
      sessionId: ctx.threadId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      grant,
      ...(options.version === "live" ? { liveVersion: true } : {}),
      ...(options.includeNodes ? { includeNodes: true } : {}),
      ...(ctx.responseId ? { responseId: ctx.responseId } : {}),
      ...(ctx.toolCallId ? { tool_use_id: ctx.toolCallId } : {}),
    },
  );
}

/** `from` on `insert`, `replace` or `copy`. */
type CopySource = { path: string; in?: ReadSelection["in"]; version?: DocumentVersion };

/** A tracked source read for a copy: its blocks and what `metadata.copiedFrom` records. */
interface CopiedSource {
  nodes: NonNullable<WriteOutcome["nodes"]>;
  copiedFrom: CopiedFrom;
}

/**
 * Reads a copy's source through `readDocument`, with `read`'s version rule
 * (D14) and the source's own destination (D20).
 */
async function readCopySource(
  deps: ToolWiringDeps,
  principal: Principal,
  command: "insert" | "replace" | "copy",
  source: CopySource,
  ctx: Pick<ToolHandlerContext, "threadId" | "turnId" | "responseId">,
): Promise<CopiedSource | WriteToolErrorOutput> {
  const resolved = await resolveCopySource(deps, command, source, ctx);
  if (isToolError(resolved)) return resolved;
  if (resolved.ref.kind !== "tracked") {
    return writeToolError(
      command,
      fromMessage(source, "The file is binary, so its blocks can't be copied."),
      "binary_file",
    );
  }
  return readTrackedCopySource(deps, principal, command, source, resolved.address, ctx);
}

async function resolveCopySource(
  deps: ToolWiringDeps,
  command: "insert" | "replace" | "copy",
  source: CopySource,
  ctx: Pick<ToolHandlerContext, "threadId" | "responseId">,
): Promise<{ ref: FileRef; address: ResolvedDocumentAddress } | WriteToolErrorOutput> {
  // A live source resolves its path against live membership, as a live read does.
  const context = await resolveContextPort(deps, ctx.threadId, ctx.responseId, source.version);
  if (isToolError(context))
    return writeToolError(command, fromMessage(source, context.output.message));
  const { filePath: basePath, fragment } = splitDocumentFile(source.path);
  const ref = await context.port.stat(basePath);
  if (!ref.ok) {
    if (ref.error.code === "not_found") {
      return writeToolError(
        command,
        fromMessage(source, documentNotFoundMessage(command)),
        "document_not_found",
      );
    }
    return writeToolError(
      command,
      fromMessage(source, modelContextErrorMessage(ref.error, context)),
    );
  }
  if (ref.value.kind === "tracked" && !ref.value.documentId) {
    return writeToolError(command, fromMessage(source, "Document id missing."));
  }
  return {
    ref: ref.value,
    address: {
      documentId: ref.value.documentId ?? "",
      uri: ref.value.uri,
      filePath: basePath,
      ...(fragment === undefined ? {} : { fragment }),
    },
  };
}

async function readTrackedCopySource(
  deps: ToolWiringDeps,
  principal: Principal,
  command: "insert" | "replace" | "copy",
  source: CopySource,
  address: ResolvedDocumentAddress,
  ctx: Pick<ToolHandlerContext, "threadId" | "turnId" | "responseId">,
): Promise<CopiedSource | WriteToolErrorOutput> {
  const grant = await documentGrant(deps, principal, command, address, "read");
  if (isToolError(grant)) {
    return writeToolError(command, fromMessage(source, grant.output.message ?? ""));
  }
  const outcome = await readDocument(
    deps,
    grant,
    address,
    {
      ...(source.in !== undefined ? { selection: { in: source.in } } : {}),
      ...(source.version ? { version: source.version } : {}),
      includeNodes: true,
    },
    // Never the write's tool call id: it keys the write's idempotency cache.
    { threadId: ctx.threadId, turnId: ctx.turnId, responseId: ctx.responseId },
  );
  if (outcome.isError) {
    return {
      isError: true,
      output: {
        ...outcome.result,
        command,
        message: fromMessage(source, outcome.result.message ?? outcome.result.status),
      },
    };
  }
  const version = outcome.result.read?.version ?? grant.destination.kind;
  return {
    nodes: outcome.nodes ?? [],
    copiedFrom: { uri: address.uri, version, revision: outcome.revision },
  };
}

/** A binary file has no blocks, so a copy of one takes no selection (D49). */
function binaryCopySelectionMessage(
  source: CopySource,
  address: ResolvedDocumentAddress,
): string | undefined {
  if (address.fragment !== undefined) {
    return "A binary file is copied whole; drop the #fragment from from.path.";
  }
  if (source.in !== undefined) return "A binary file is copied whole; drop from.in.";
  return undefined;
}

/** Errors about the source say so, since `path` names the destination. */
function fromMessage(source: CopySource, message: string): string {
  return `from ${source.path}: ${message}`;
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
          refused: result.refused.map((refusal) => ({
            documentId: refusal.documentId,
            ...refusedAtSave(refusal.denial),
          })),
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
  const args = input as AskUserToolInput;
  const timeoutMs = args.timeoutMs ?? ctx.interruptTimeoutMs;
  const request = askRequestFromAskUser(args, crypto.randomUUID());

  const response = await ctx.interrupt(request, timeoutMs);
  const resolvedProps = interruptResolvedPropsFromAnswer(response);
  await ctx.updateComponentBlock(request.interruptId, resolvedProps);
  return { value: resolvedProps.resolvedValue, provenance: response.provenance };
}

function referenceError(message: string): JsonValue {
  return JSON.parse(JSON.stringify(writeToolError("read", message).output));
}

/** Reference loading resolves the mention and calls `readDocument`, as the `read` tool does. */
export function createReferenceReader(deps: ToolWiringDeps): ReferenceReader {
  return {
    async read(reference, ctx) {
      const execution = await resolveExecutionContext(deps, ctx.threadId);
      if ("isError" in execution)
        return { result: referenceError(execution.output.message), revision: null };
      const context = await resolveContextPort(deps, ctx.threadId);
      if ("isError" in context)
        return { result: referenceError(context.output.message), revision: null };
      const address = await resolveDocumentAddress(context, "read", reference.uri);
      if (isToolError(address))
        return { result: JSON.parse(JSON.stringify(address.output)), revision: null };
      if (address.documentId !== reference.documentId) {
        return {
          revision: null,
          result: JSON.parse(
            JSON.stringify(
              writeToolError(
                "read",
                "Referenced document is no longer available at this URI.",
                "document_not_found",
              ).output,
            ),
          ),
        };
      }
      const principal = await agentPrincipal(deps, context, execution);
      const grant = await documentGrant(deps, principal, "read", address, "read");
      if (isToolError(grant))
        return { result: JSON.parse(JSON.stringify(grant.output)), revision: null };
      const outcome = await readDocument(deps, grant, address, {}, ctx);
      if (!outcome.isError) recordTouchInBackground(deps, address.documentId, ctx);
      return { result: JSON.parse(JSON.stringify(outcome.result)), revision: outcome.revision };
    },
  };
}

/** Host evidence for the document a `read` or `write` call touched. */
function documentRevisionMetadata(address: ResolvedDocumentAddress, outcome: WriteOutcome) {
  return {
    documentRevisions: [
      {
        documentId: address.documentId,
        uri: address.uri,
        revision: outcome.revision,
      } satisfies DocumentRevisionEvidence,
    ],
  };
}

/**
 * A binary copy duplicates the stored object at once (D24). It isn't a Yjs
 * write, so it has no write handle, isn't part of the reply's save and is
 * never drafted.
 */
async function copyBinary(
  deps: ToolWiringDeps,
  context: ResolvedModelContextPort,
  input: Extract<WriteToolInput, { command: "copy" }>,
  source: BinaryFileRef,
  sourceGrant: FileGrant<"read">,
  ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
) {
  // Binary files have no drafts or revisions, so the copy always reads the live file.
  const copied = await copyBinaryDocument({
    port: context.port,
    livePort: context.livePort(),
    objectStore: deps.objectStore,
    source,
    sourceGrant,
    destinationUri: splitDocumentFile(input.path).filePath,
    copiedFrom: { uri: source.uri, version: "live", revision: null },
  });
  if (!copied.ok) {
    return writeToolError(input.command, modelContextErrorMessage(copied.error, context));
  }
  if (copied.value.documentId) recordTouchInBackground(deps, copied.value.documentId, ctx);
  return {
    output: modelResult({
      command: "copy",
      status: "success",
      phase: "committed",
      payload: { path: input.path, destination: "live", copied: { from: input.from.path } },
    }),
  };
}

function firstRefusal(refusal: FileEditRefusedError): FileAccessDenied {
  const [denial] = refusal.refused;
  if (!denial) throw new Error("A refused edit names at least one grant");
  return denial;
}

/**
 * The write itself: the edit grant on the document, then the pool call that
 * carries it. A seam that refuses the grant under its locks reports the same
 * error a preflight denial does.
 */
async function writeUnderGrant(
  deps: ToolWiringDeps,
  principal: Principal,
  parsed: WriteToolInput,
  address: ResolvedDocumentAddress,
  copied: CopiedSource | undefined,
  ctx: ToolHandlerContext,
): Promise<(WriteOutcome & { isError: false }) | WriteToolErrorOutput> {
  const grant = await documentGrant(deps, principal, parsed.command, address, "edit");
  if (isToolError(grant)) return grant;
  let written: WriteOutcome;
  try {
    written = await deps.documentSync
      .agentEdit()
      .write(buildAgentWriteCommand(parsed, address, ctx.toolCallId), {
        sessionId: ctx.threadId,
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        responseId: ctx.responseId,
        tool_use_id: ctx.toolCallId,
        createdDocument: address.created === true,
        grant,
        ...(copied ? { copiedNodes: copied.nodes } : {}),
      });
  } catch (cause) {
    if (!(cause instanceof FileEditRefusedError)) throw cause;
    return fileAccessDeniedError(parsed.command, firstRefusal(cause), address.filePath);
  }
  if (written.isError) return { isError: true, output: written.result };
  // Undo and redo go where history says, so only forward writes name a destination.
  const reversal = parsed.command === "undo" || parsed.command === "redo";
  return (reversal ? written : withDestination(written, grant.destination)) as WriteOutcome & {
    isError: false;
  };
}

/**
 * A list call's port and principal (file-access §6). A `live` listing reads
 * no draft, so its rows are decided live.
 */
async function listingContext(
  deps: ToolWiringDeps,
  ctx: ToolHandlerContext,
  version: DocumentVersion | undefined,
): Promise<{ context: ResolvedModelContextPort; principal: Principal } | ToolErrorOutput> {
  const execution = await resolveExecutionContext(deps, ctx.threadId);
  if (isToolError(execution)) return execution;
  const context = await resolveContextPort(deps, ctx.threadId, ctx.responseId, version);
  if (isToolError(context)) return context;
  const principal = await agentPrincipal(deps, context, execution);
  if (version !== "live" || !principal.agent) return { context, principal };
  return { context, principal: { ...principal, agent: { ...principal.agent, draftWork: null } } };
}

function listedDocumentIds(rows: readonly { documentId?: string }[]): DocumentId[] {
  return rows.flatMap((row) => (row.documentId ? [row.documentId as DocumentId] : []));
}

/** Whether the agent may create in the folder a listing names; undefined when it names no owner. */
async function containerReadonly(
  deps: ToolWiringDeps,
  principal: Principal,
  context: ResolvedModelContextPort,
  path: string,
): Promise<boolean | undefined> {
  const target = await containerTarget(deps, context, path);
  if (!target) return undefined;
  return isFileAccessDenied(await deps.fileAccess.authorize(principal, target, "edit"));
}

export function createWiredCoreToolRegistrations(deps: ToolWiringDeps): ToolRegistration[] {
  const readHandler = async (input: unknown, ctx: ToolHandlerContext) => {
    const { path, format, version, ...selection } = input as ReadToolInput;
    const execution = await resolveExecutionContext(deps, ctx.threadId);
    if ("isError" in execution) return writeToolError("read", execution.output.message);
    // A live read resolves the path against live membership too.
    const context = await resolveContextPort(deps, ctx.threadId, ctx.responseId, version);
    if ("isError" in context) return writeToolError("read", context.output.message);
    const address = await resolveDocumentAddress(context, "read", path);
    if (isToolError(address)) return address;
    const principal = await agentPrincipal(deps, context, execution);
    const grant = await documentGrant(deps, principal, "read", address, "read");
    if (isToolError(grant)) return grant;

    const outcome = await readDocument(
      deps,
      grant,
      address,
      { selection, format, ...(version ? { version } : {}) },
      ctx,
    );
    if (outcome.isError) return { isError: true, output: outcome.result };
    recordTouchInBackground(deps, address.documentId, ctx);
    return { output: outcome.result, metadata: documentRevisionMetadata(address, outcome) };
  };

  const writeHandler = async (input: unknown, ctx: ToolHandlerContext) => {
    const parsed = input as WriteToolInput;
    const execution = await resolveExecutionContext(deps, ctx.threadId);
    if ("isError" in execution) return writeToolError(parsed.command, execution.output.message);

    const portOrError = await resolveContextPort(deps, ctx.threadId, ctx.responseId);
    if ("isError" in portOrError) {
      return writeToolError(parsed.command, portOrError.output.message);
    }

    const principal = await agentPrincipal(deps, portOrError, execution);
    const creates = parsed.command === "create" || parsed.command === "copy";
    // A create or copy needs edit on the folder it makes the file in, at the
    // destination the file lands in; the namespace transaction confirms that
    // grant under its locks (seam C).
    const target = creates ? await containerTarget(deps, portOrError, parsed.path) : null;
    const inContainer = async <T>(
      asPrincipal: Principal,
      operation: () => Promise<T>,
    ): Promise<T | WriteToolErrorOutput> => {
      if (!target) return operation();
      const grant = await deps.fileAccess.authorize(asPrincipal, target, "edit");
      if (isFileAccessDenied(grant)) return fileAccessDeniedError(parsed.command, grant);
      const result = await runWithEditGrants(deps.fileAccess, [grant], operation);
      if (result.ok) return result.value;
      return fileAccessDeniedError(parsed.command, firstRefusal(result.refusal));
    };

    // A copy reads its source before it creates anything, so a bad source leaves no file.
    let copied: CopiedSource | undefined;
    if (parsed.command === "copy") {
      const source = await resolveCopySource(deps, parsed.command, parsed.from, ctx);
      if (isToolError(source)) return source;
      if (source.ref.kind === "binary") {
        const selection = binaryCopySelectionMessage(parsed.from, source.address);
        if (selection) {
          return writeToolError(parsed.command, fromMessage(parsed.from, selection), "binary_file");
        }
        const binary = source.ref;
        const sourceGrant = await documentGrant(
          deps,
          principal,
          parsed.command,
          source.address,
          "read",
        );
        if (isToolError(sourceGrant)) {
          return writeToolError(
            parsed.command,
            fromMessage(parsed.from, sourceGrant.output.message ?? ""),
          );
        }
        // A binary copy always lands live (D24), so its folder is judged live.
        const livePrincipal = principal.agent
          ? { ...principal, agent: { ...principal.agent, draftWork: null } }
          : principal;
        return inContainer(livePrincipal, () =>
          copyBinary(deps, portOrError, parsed, binary, sourceGrant, ctx),
        );
      }
      const read = await readTrackedCopySource(
        deps,
        principal,
        parsed.command,
        parsed.from,
        source.address,
        ctx,
      );
      if (isToolError(read)) return read;
      copied = read;
    } else if ((parsed.command === "insert" || parsed.command === "replace") && parsed.from) {
      const read = await readCopySource(deps, principal, parsed.command, parsed.from, ctx);
      if (isToolError(read)) return read;
      copied = read;
    }

    const address = await inContainer(principal, () =>
      resolveDocumentAddress(portOrError, parsed.command, parsed.path, {
        deferTrackedDocumentSync: creates && ctx.responseId !== undefined,
        ...(parsed.command === "copy" && copied
          ? { metadata: { copiedFrom: copied.copiedFrom } }
          : {}),
      }),
    );
    if (isToolError(address)) return address;

    const outcome = await writeUnderGrant(deps, principal, parsed, address, copied, ctx);
    const stagedCreate = creates && ctx.responseId !== undefined && address.created === true;
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
      return { isError: true, output: outcome.output };
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
    // Undo and redo apply at once; every other write stages until the response commits.
    const stagedWrite =
      ctx.responseId !== undefined && parsed.command !== "undo" && parsed.command !== "redo";
    if (!stagedWrite) await refreshProjectionAfterToolWrite(deps, address.documentId, ctx);
    return {
      output: outcome.result,
      metadata: {
        ...documentRevisionMetadata(address, outcome),
        ...(stagedWrite
          ? {
              documentId: address.documentId,
              stagedWrite: true,
              ...(outcome.writeId ? { writeId: outcome.writeId } : {}),
              ...(outcome.settlementId ? { settlementId: outcome.settlementId } : {}),
            }
          : {}),
      },
    };
  };

  return createCoreToolRegistrations({
    read: readHandler,
    write: writeHandler,
    work: async (input: unknown, ctx: ToolHandlerContext) => {
      const command = input as WorkCommand;
      const thread = await deps.threads.findById(ctx.threadId);
      if (!thread) return toolError({ message: `Thread not found: ${ctx.threadId}` });
      // A switch that couldn't happen says why before the policy asks for approval (D37).
      const switchTarget =
        command.command === "switch"
          ? await resolveSwitchTarget(deps, thread.projectId, thread.id as ThreadId, command.work)
          : null;
      if (switchTarget && "isError" in switchTarget) return switchTarget;
      if (switchTarget && "unchanged" in switchTarget) return switchTarget.unchanged;
      const chain = await deps.readAgentChain(thread.id as ThreadId);
      const decision = actionPolicy(chain, `work.${command.command}`);
      if (decision !== "allow") {
        return toolError({
          code: "permission_denied",
          reason: "action_denied" satisfies PermissionDeniedReason,
          message: workActionRefusal(command, decision),
        });
      }

      try {
        if (command.command === "list") {
          const works = await deps.works.listByProject(thread.projectId, {
            lifecycle: command.archived ? "archived" : "active",
          });
          return works.map(modelWork);
        }

        if (command.command === "create") {
          const work = await createWork(
            { works: deps.works },
            {
              projectId: thread.projectId,
              createdByUserId: thread.userId,
              name: command.name,
              goal: command.goal,
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
                inverse: { command: "delete", workId: work.id },
              } satisfies WorkReceipt,
            },
          };
        }

        if (command.command === "switch") {
          if (!switchTarget) throw new Error("A switch resolves its target first");
          const workId = switchTarget.work.id;
          const rebound = await deps.transaction(() =>
            rebindThreadWork(
              {
                threads: deps.threads,
                threadWorks: deps.threadWorks,
                works: deps.works,
                workContextNotices: deps.workContextNotices,
              },
              {
                threadId: thread.id,
                workId,
              },
            ),
          );
          return {
            output: {
              workId: rebound.after.workId,
              slug: rebound.after.slug,
              name: rebound.after.name,
              goal: rebound.after.goal,
              status: rebound.after.status,
              archived: rebound.after.archived,
              aiWriteMode: rebound.after.aiWriteMode,
            },
            metadata: {
              workReceipt: rebound.receipt,
            },
          };
        }

        const selected = await workBySlug(deps, thread.projectId, command.work);
        if (isToolError(selected)) return selected;

        if (command.command === "show") {
          const [threads, drafts] = await Promise.all([
            deps.threads.listRecentByWork(thread.projectId, selected.id, 10),
            deps.drafts.draftReview.list({ projectId: thread.projectId, workId: selected.id }),
          ]);
          return {
            work: modelWork(selected),
            recentThreads: threads.map(({ title, updatedAt, status }) => ({
              title,
              updatedAt,
              status,
            })),
            drafts: drafts.map(({ workId: _workId, ...draft }) => draft),
          };
        }

        if (command.command === "update") {
          const transition = await updateWorkTransition(
            { works: deps.works, workContextNotices: deps.workContextNotices },
            selected.id,
            { name: command.name, goal: command.goal, status: command.status },
            { originThreadId: thread.id },
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
            },
          };
        }

        if (command.command === "archive" || command.command === "unarchive") {
          const transition = await setWorkArchived(
            { works: deps.works, workContextNotices: deps.workContextNotices },
            selected.id,
            command.command === "archive",
            { originThreadId: thread.id },
          );
          const { before, after, changed } = transition;
          return {
            output: modelWork(after),
            metadata: {
              workReceipt: {
                operation: "update",
                category: "mutate",
                changed,
                workId: after.id,
                workName: after.name,
                before: receiptState(before),
                after: receiptState(after),
                inverse: changed
                  ? { command: "update", workId: before.id, state: receiptState(before) }
                  : null,
              } satisfies WorkReceipt,
            },
          };
        }

        if (command.command === "delete") {
          const transition = await deleteWorkTransition(
            {
              works: deps.works,
              stopThreadRun: deps.stopThreadRun,
            },
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
            },
          };
        }
      } catch (error) {
        if (error instanceof RebindThreadWorkError) {
          return toolError({
            code: error.code,
            message: error.message,
            ...(error.workId ? { workId: error.workId } : {}),
          });
        }
        if (error instanceof WorkStatusInvalidError) {
          return toolError({ code: "invalid_work_status", message: error.message });
        }
        if (error instanceof WorkNameRequiredError) {
          return toolError({ code: "invalid_work_name", message: error.message });
        }
        if (error instanceof WorkLifecycleUnavailableError) {
          const reason = `work_${error.state}` as const;
          return toolError({
            code: error.state === "archived" ? "work_archived" : "work_not_found",
            message: workLifecycleMessage(
              reason,
              "work" in command && command.work ? command.work : (error.workSlug ?? null),
              actionPolicy(chain, "work.unarchive") === "allow",
            ),
          });
        }
        return toolError({ message: error instanceof Error ? error.message : String(error) });
      }
    },
    ls: async (input: unknown, ctx: ToolHandlerContext) => {
      const { path, version } = input as LsToolInput;
      const listed = await listingContext(deps, ctx, version);
      if (isToolError(listed)) return listed;
      const { context, principal } = listed;
      const result = await context.port.list(path);
      if (!result.ok) return modelContextError(result.error, context);
      const access = await deps.fileAccess.listAccess(principal, listedDocumentIds(result.value));
      const folderReadonly = path
        ? await containerReadonly(deps, principal, context, path)
        : undefined;
      const entries = result.value.flatMap((entry) => {
        const { editable: _kind, ...rest } = entry as FileEntry & { editable?: boolean };
        if (entry.kind === "directory") {
          return [{ ...rest, readonly: folderReadonly ?? entry.readonly ?? false }];
        }
        const decision = entry.documentId ? access.get(entry.documentId as DocumentId) : undefined;
        return decision ? [{ ...rest, readonly: decision.level !== "edit" }] : [];
      });
      return modelContextResults(entries, context);
    },
    search: async (input: unknown, ctx: ToolHandlerContext) => {
      const { pattern, scope, version } = input as SearchToolInput;
      const listed = await listingContext(deps, ctx, version);
      if (isToolError(listed)) return listed;
      const { context, principal } = listed;
      const result = await context.port.search(pattern, scope);
      if (!result.ok) return modelContextError(result.error, context);
      const access = await deps.fileAccess.listAccess(principal, listedDocumentIds(result.value));
      const hits = result.value.flatMap((hit) => {
        const decision = hit.documentId ? access.get(hit.documentId as DocumentId) : undefined;
        return decision ? [{ hit, readonly: decision.level !== "edit" }] : [];
      });
      return {
        output: modelContextResults(
          hits.map(({ hit: { documentId: _id, revision: _revision, ...hit }, readonly }) => ({
            ...hit,
            readonly,
          })),
          context,
        ),
        metadata: {
          documentRevisions: hits.map(
            ({ hit: { documentId, uri, revision } }) =>
              ({
                documentId,
                uri,
                revision,
              }) satisfies DocumentRevisionEvidence,
          ),
        },
      };
    },
    ask_user: askUserHandler,
  });
}
