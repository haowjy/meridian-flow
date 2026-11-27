import type {
  DocumentAddress,
  DocumentVersion,
  WriteErrorStatus,
} from "@meridian/agent-edit/integration";
import { modelResult, splitDocumentFile } from "@meridian/agent-edit/integration";
import type { ResponseAuthorship } from "@meridian/contracts";
import type { AgentPermission } from "@meridian/contracts/agents";
import {
  CONTEXT_URI_SCHEMES,
  contextRootUri,
  parseUnifiedContextUri,
} from "@meridian/contracts/context-uri";
import {
  type MeridianError,
  meridianErrorFromStructuredToolOutput,
  meridianErrorFromTool,
} from "@meridian/contracts/errors";
import type { DocumentRevisionEvidence } from "@meridian/contracts/protocol";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import { type ThreadExecutionContext, workLifecycleState } from "@meridian/contracts/works";
import type {
  AgentEditAccess,
  CollabDrafts,
  DocumentProjectionRefresher,
  ModelEvidence,
} from "../../domains/collab/index.js";
import {
  contextPortForThread,
  resolveThreadContext,
  type ThreadContextResolution,
} from "../../domains/context/context-port-resolution.js";
import type { ContextError, ContextPort } from "../../domains/context/ports/context-port.js";
import type { DocumentRemovals } from "../../domains/context/ports/document-removal.js";
import type { DocumentTrash } from "../../domains/context/ports/document-trash.js";
import type { UnifiedContextPortFactory } from "../../domains/context/unified-context-port-factory.js";
import type { AgentChain, FileAccess, Principal } from "../../domains/file-policy/index.js";
import type { NoticePort } from "../../domains/notices/index.js";
import type { EventSink } from "../../domains/observability/index.js";
import type { BoundAgentCatalog } from "../../domains/packages/index.js";
import type {
  ProjectWorkAuthorityResolver,
  WorkContextNotices,
  WorkRepository,
} from "../../domains/projects/index.js";
import type { PermissionGrantStore } from "../../domains/runtime/index.js";
import { SKILLS_URI_ROOT, type SkillFilesDeps } from "../../domains/runtime/index.js";
import type { ThreadControls } from "../../domains/runtime/loop/delivery/runtime-delivery.js";
import type { ObjectRelease, ObjectStorePort } from "../../domains/storage/index.js";
import type { ThreadRepository, ThreadWorksRepository } from "../../domains/threads/index.js";
import { threadExecutionContext } from "../../domains/threads/index.js";
import { agentPrincipal } from "./file-access.js";

export interface ToolWiringDeps {
  threads: ThreadRepository;
  contextPorts: UnifiedContextPortFactory;
  documentSync: AgentEditAccess & DocumentProjectionRefresher;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary" | "rebindPrimary">;
  works: WorkRepository;
  permissionGrants: PermissionGrantStore;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
  workContextNotices: Pick<WorkContextNotices, "workChanged" | "threadChanged">;
  notices: Pick<NoticePort, "record">;
  controls: Pick<ThreadControls, "enqueueControl">;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  // `threadIds` must be parents first (`parentsFirst`), or a Stop deadlocks against cancellation
  stopThreads(threadIds: readonly ThreadId[]): Promise<void>;
  drafts: Pick<CollabDrafts, "draftReview">;
  agentCatalog: Pick<BoundAgentCatalog, "savePackages">;
  eventSink: EventSink;
  objectStore: ObjectStorePort;
  release: ObjectRelease;
  fileAccess: Pick<
    FileAccess,
    "authorize" | "authorizeAt" | "confirmEdit" | "listAccess" | "historyAccess"
  >;
  documentRemovals: DocumentRemovals;
  documentTrash: Pick<DocumentTrash, "retained">;
  agentRevisions: SkillFilesDeps["agentRevisions"];
  readAgentChain(threadId: ThreadId): Promise<AgentChain>;
  readChainPermission(threadId: ThreadId): Promise<AgentPermission>;
  shownLinks: Pick<ModelEvidence, "forDocument">;
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
};

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

export async function resolveToolCall(
  deps: ToolWiringDeps,
  ctx: { threadId: string; responseIdentity?: ResponseAuthorship },
  version?: DocumentVersion,
): Promise<ToolCall | ToolErrorOutput> {
  const context = await resolveContextPort(deps, ctx.threadId, version);
  if (isToolError(context)) return context;
  const { primaryWorkId, primaryWork } = context.resolution;
  if (!primaryWorkId) throw new Error(`Thread primary Work is missing: ${ctx.threadId}`);
  if (!primaryWork || workLifecycleState(primaryWork) === "deleted") {
    return toolError({ code: "work_unavailable", message: "The current Work is unavailable" });
  }
  const execution = threadExecutionContext(primaryWork, context.resolution.thread);
  return { execution, context, principal: await agentPrincipal(deps, context, execution) };
}

export async function resolveContextPort(
  deps: ToolWiringDeps,
  threadId: string,
  version?: DocumentVersion,
): Promise<ResolvedModelContextPort | ToolErrorOutput> {
  const resolution = await resolveThreadContext(
    {
      ...deps,
      scratchLineages: deps.contextPorts.lineages,
      topPrimaryChats: deps.contextPorts.topPrimaryChats,
      uploadChats: deps.contextPorts.chats,
    },
    threadId,
  );
  if (!resolution) return toolError({ message: `Thread not found: ${threadId}` });
  return {
    resolution,
    port: contextPortForThread(deps.contextPorts, resolution, version ? { version } : {}),
  };
}

export function contextToolError(error: ContextError): ToolErrorOutput {
  return toolError({ code: error.code, message: contextErrorMessage(error), details: error });
}

const MODEL_ADDRESS_ROOTS = [
  ...CONTEXT_URI_SCHEMES.map((scheme) => contextRootUri(scheme)),
  SKILLS_URI_ROOT,
];

export function contextErrorMessage(error: ContextError): string {
  if (error.code === "context_unavailable") {
    const work = error.workHandle ? `Work ${error.workHandle}` : "The requested Work";
    return error.reason === "work_archived"
      ? error.workHandle
        ? `${work} is archived; change not made.`
        : `${work} is archived, so this change wasn't made.`
      : `${work} is unavailable.`;
  }
  if (error.code === "invalid_uri" && error.unknownScheme !== undefined) {
    const known = MODEL_ADDRESS_ROOTS.join(", ");
    return `Unknown scheme "${error.unknownScheme}". Known schemes: ${known}`;
  }
  if (error.code === "invalid_uri") return error.reason;
  if (error.code === "not_found") return `No file or folder at ${error.uri}.`;
  if ("message" in error && typeof error.message === "string") return error.message;
  return `${error.code}: ${error.uri}`;
}

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

export async function canonicalPath(call: ToolCall, path: string): Promise<string> {
  const { filePath } = splitDocumentFile(path);
  const parsed = parseUnifiedContextUri(filePath);
  const uri = parsed.ok ? parsed.value.normalized : filePath;
  const slash = uri.lastIndexOf("/");
  const listing = await call.context.port.list(uri.slice(0, slash + 1));
  const folder = listing.ok ? listing.value.uri : null;
  return folder ? `${folder.replace(/\/?$/, "/")}${uri.slice(slash + 1)}` : uri;
}
