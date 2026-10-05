/**
 * Shared ground for the model tools: their dependencies, error shapes, the
 * one per-call resolution (thread, Work, context port, principal), and the
 * model's copy for context errors.
 */
import type {
  DocumentAddress,
  DocumentVersion,
  WriteErrorStatus,
} from "@meridian/agent-edit/integration";
import { modelResult } from "@meridian/agent-edit/integration";
import type { AgentPermission } from "@meridian/contracts/agents";
import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import {
  type MeridianError,
  meridianErrorFromStructuredToolOutput,
  meridianErrorFromTool,
} from "@meridian/contracts/interrupt";
import type { DocumentRevisionEvidence } from "@meridian/contracts/protocol";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import { type ThreadExecutionContext, workLifecycleState } from "@meridian/contracts/works";
import type {
  AgentEditAccess,
  CollabDrafts,
  DocumentProjectionRefresher,
  ResponseWriteFinalizer,
} from "../../domains/collab/index.js";
import {
  contextPortForThread,
  resolveThreadContext,
  type ThreadContextResolution,
} from "../../domains/context/context-port-resolution.js";
import type { ContextError, ContextPort } from "../../domains/context/ports/context-port.js";
import type { UnifiedContextPortFactory } from "../../domains/context/unified-context-port-factory.js";
import type { AgentChain, FileAccess, Principal } from "../../domains/file-policy/index.js";
import {
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../../domains/observability/index.js";
import type {
  ProjectWorkAuthorityResolver,
  WorkContextNotices,
  WorkRepository,
} from "../../domains/projects/index.js";
import {
  SKILLS_URI_ROOT,
  type SkillFilesDeps,
  type ToolHandlerContext,
} from "../../domains/runtime/index.js";
import type { ObjectStorePort } from "../../domains/storage/index.js";
import type {
  ThreadRepository,
  ThreadWorksRepository,
  TurnDocumentTouchRepository,
} from "../../domains/threads/index.js";
import { threadExecutionContext } from "../../domains/threads/index.js";
import { agentPrincipal } from "./file-access.js";
import type { AgentEditResponseWriteLifecycle } from "./response-write-lifecycle.js";

export interface ToolWiringDeps {
  threads: ThreadRepository;
  contextPorts: UnifiedContextPortFactory;
  documentSync: AgentEditAccess & DocumentProjectionRefresher & ResponseWriteFinalizer;
  responseWrites: Pick<AgentEditResponseWriteLifecycle, "trackStagedCreate">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary">;
  works: WorkRepository;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
  workContextNotices: Pick<WorkContextNotices, "workChanged" | "threadChanged">;
  stopThreadRun(threadId: ThreadId): Promise<void>;
  drafts: Pick<CollabDrafts, "draftReview">;
  documentTouches?: TurnDocumentTouchRepository;
  eventSink: EventSink;
  /** Binary copies duplicate the stored object (D24). */
  objectStore: ObjectStorePort;
  /** Every model read and write asks the file policy first (file-access §1). */
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit" | "listAccess">;
  /** The calling thread's bound skills, read as files under `skills://` (D52). */
  agentRevisions: SkillFilesDeps["agentRevisions"];
  /** The calling thread's delegation chain, read fresh per call (file-access §8). */
  readAgentChain(threadId: ThreadId): Promise<AgentChain>;
  /** The chain's effective permission, for the action policy (D39). */
  readChainPermission(threadId: ThreadId): Promise<AgentPermission>;
}

export type ToolErrorOutput = { isError: true; output: MeridianError };
export type WriteToolErrorOutput = {
  isError: true;
  output: ReturnType<typeof modelResult>;
};
export type ResolvedDocumentAddress = DocumentAddress & { uri: string; created?: boolean };

export type ResolvedModelContextPort = {
  resolution: ThreadContextResolution;
  port: ContextPort;
  /** The same thread's port with every write live, whatever the Work's mode. */
  livePort: () => ContextPort;
};

/** One tool call's resolved ground: the thread's Work, its context port, and who acts. */
export interface ToolCall {
  execution: ThreadExecutionContext;
  context: ResolvedModelContextPort;
  principal: Principal;
}

export function toolError(
  error: ContextError | ({ message: string; code?: string } & Record<string, unknown>),
): ToolErrorOutput {
  if ("code" in error && typeof error.code === "string") {
    return { isError: true, output: meridianErrorFromStructuredToolOutput(error as JsonValue) };
  }
  return { isError: true, output: meridianErrorFromTool(error.message) };
}

export function writeToolError(
  command: Parameters<typeof modelResult>[0]["command"],
  message: string,
  status: WriteErrorStatus = "invalid_write",
  payload: { path?: string } = {},
): WriteToolErrorOutput {
  return {
    isError: true,
    output: modelResult({ command, status, payload: { ...payload, message } }),
  };
}

export function isToolError(value: unknown): value is ToolErrorOutput | WriteToolErrorOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    "isError" in value &&
    (value as { isError?: boolean }).isError === true
  );
}

/**
 * The thread's context, its port at `version` (a live read resolves paths
 * against live membership too), its Work's execution context and the
 * principal. The thread and its Work load once.
 */
export async function resolveToolCall(
  deps: ToolWiringDeps,
  ctx: { threadId: string; responseId?: string },
  version?: DocumentVersion,
): Promise<ToolCall | ToolErrorOutput> {
  const context = await resolveContextPort(deps, ctx.threadId, ctx.responseId, version);
  if (isToolError(context)) return context;
  const { primaryWorkId, primaryWork } = context.resolution;
  if (!primaryWorkId) throw new Error(`Thread primary Work is missing: ${ctx.threadId}`);
  if (!primaryWork || workLifecycleState(primaryWork) === "deleted") {
    return toolError({ code: "work_unavailable", message: "The current Work is unavailable" });
  }
  const execution = threadExecutionContext(primaryWork);
  return { execution, context, principal: await agentPrincipal(deps, context, execution) };
}

export async function resolveContextPort(
  deps: ToolWiringDeps,
  threadId: string,
  responseId?: string,
  version?: DocumentVersion,
): Promise<ResolvedModelContextPort | ToolErrorOutput> {
  const resolution = await resolveThreadContext(deps, threadId);
  if (!resolution) return toolError({ message: `Thread not found: ${threadId}` });
  return {
    resolution,
    port: contextPortForThread(deps.contextPorts, resolution, {
      responseId,
      ...(version ? { version } : {}),
    }),
    livePort: () =>
      contextPortForThread(deps.contextPorts, resolution, { responseId, liveWrites: true }),
  };
}

// The context error itself rides in `details`; the message is its readable reason.
export function contextToolError(error: ContextError): ToolErrorOutput {
  return toolError({ code: error.code, message: contextErrorMessage(error), details: error });
}

// skills:// is model-only, so the shared context parser doesn't name it (D52).
const MODEL_SCHEMES = [...CONTEXT_URI_SCHEMES, SKILLS_URI_ROOT.slice(0, -"://".length)];

export function contextErrorMessage(error: ContextError): string {
  if (error.code === "context_unavailable") {
    // The file policy refuses an archived Work's files first, with copy fit for
    // the agent; this storage-side refusal only follows an archive mid-call.
    const work = error.workSlug ? `Work @${error.workSlug}` : "The requested Work";
    return error.reason === "work_archived"
      ? `${work} is archived, so this change wasn't made.`
      : `${work} is unavailable.`;
  }
  if (error.code === "invalid_uri" && error.unknownScheme !== undefined) {
    const known = MODEL_SCHEMES.map((scheme) => `${scheme}://`).join(", ");
    return `Unknown scheme "${error.unknownScheme}". Known schemes: ${known}`;
  }
  if (error.code === "invalid_uri") return error.reason;
  if ("message" in error && typeof error.message === "string") return error.message;
  return `${error.code}: ${error.uri}`;
}

export function recordTouchInBackground(
  deps: Pick<ToolWiringDeps, "documentTouches" | "eventSink">,
  documentId: string | undefined,
  ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
): void {
  if (!deps.documentTouches || !documentId) return;
  const eventSink = deps.eventSink;
  void deps.documentTouches.recordTouch(ctx.turnId, documentId).catch((error) => {
    emitEvent(eventSink, {
      level: "warn",
      source: "lib.model-tools",
      name: "document_touch.failed",
      correlation: { threadId: ctx.threadId, turnId: ctx.turnId, runId: ctx.turnId },
      payload: {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        documentId,
        ...unknownToEventPayload(error),
      },
    });
  });
}

/** Host evidence for the document a `read` or `write` call touched. */
export function documentRevisionMetadata(
  address: ResolvedDocumentAddress,
  revision: DocumentRevisionEvidence["revision"],
) {
  return {
    documentRevisions: [
      {
        documentId: address.documentId,
        uri: address.uri,
        revision,
      } satisfies DocumentRevisionEvidence,
    ],
  };
}
