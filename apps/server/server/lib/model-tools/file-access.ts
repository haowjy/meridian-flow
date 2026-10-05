/**
 * The model tools' file-access adapter (file-access §1, §8): who a call acts
 * as, the grants it asks the file policy for, and a refusal as the tool's
 * error. Refusal copy lives in `file-access-denial-copy.ts`.
 */
import type { DocumentCommandName } from "@meridian/agent-edit/integration";
import { documentNotFoundMessage, modelResult } from "@meridian/agent-edit/integration";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { ThreadExecutionContext } from "@meridian/contracts/works";
import type { RoutedWriteOutcome } from "../../domains/collab/index.js";
import {
  type FileAccessDenied,
  type FileEditRefusedError,
  type FileGrant,
  type FileNeed,
  type FileTarget,
  isFileAccessDenied,
  type Principal,
  runWithEditGrants,
  type WorkRef,
} from "../../domains/file-policy/index.js";
import {
  deletedFileMessage,
  isPermissionDenial,
  permissionDeniedMessage,
} from "../file-access-denial-copy.js";
import { threadContainerTarget } from "../file-targets.js";
import type {
  ResolvedDocumentAddress,
  ResolvedModelContextPort,
  ToolWiringDeps,
  WriteToolErrorOutput,
} from "./tool-context.js";

/** The principal with its drafted writes routed to `work`'s draft, or live for null. */
export function withDraftWork(principal: Principal, work: WorkRef | null): Principal {
  return principal.agent
    ? { ...principal, agent: { ...principal.agent, draftWork: work } }
    : principal;
}

/**
 * The agent a tool call acts as (file-access §8): the thread's person, its
 * delegation chain read fresh, and the Work whose draft its drafted writes
 * land in.
 */
export async function agentPrincipal(
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

/**
 * An explicit `version: "draft"` outside draft mode reads the draft the Work
 * kept when it switched to auto-apply (D40), so the result says `draft`. With
 * no kept draft of this document it reads live, as `draft` always did there.
 */
export async function keptDraftReader(
  deps: Pick<ToolWiringDeps, "drafts">,
  principal: Principal,
  execution: ThreadExecutionContext,
  documentId: string,
): Promise<Principal> {
  if (!principal.agent || principal.agent.draftWork || execution.draftOwner) return principal;
  const { workId, workSlug } = execution.scope;
  const drafts = await deps.drafts.draftReview.list({ workId });
  if (!drafts.some((draft) => draft.documentId === documentId)) return principal;
  return withDraftWork(principal, { id: workId, slug: workSlug });
}

/** The file policy's grant on a document; a denial comes back as the tool's error. */
export async function documentGrant<N extends FileNeed>(
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

/** A refused grant as the tool's error: `permission_denied` with its reason (§9). */
export function fileAccessDeniedError(
  command: DocumentCommandName,
  denial: FileAccessDenied,
  path?: string,
): WriteToolErrorOutput {
  const at = path ? { path } : {};
  if (!isPermissionDenial(denial)) {
    return {
      isError: true,
      output: modelResult({
        command,
        status: "document_not_found",
        payload: { ...at, message: documentNotFoundMessage(command) },
      }),
    };
  }
  return {
    isError: true,
    output: modelResult({
      command,
      status: "permission_denied",
      payload: { ...at, reason: denial.reason, message: permissionDeniedMessage(denial) },
    }),
  };
}

export function firstRefusal(refusal: FileEditRefusedError): FileAccessDenied {
  const [denial] = refusal.refused;
  if (!denial) throw new Error("A refused edit names at least one grant");
  return denial;
}

/**
 * Runs `operation` under the edit grant on the container a create or copy
 * makes its file in; the namespace transaction confirms it under its locks
 * (seam C). No target runs it bare.
 */
export async function inContainer<T>(
  deps: Pick<ToolWiringDeps, "fileAccess">,
  principal: Principal,
  command: DocumentCommandName,
  target: FileTarget | null,
  operation: () => Promise<T>,
): Promise<T | WriteToolErrorOutput> {
  if (!target) return operation();
  const grant = await deps.fileAccess.authorize(principal, target, "edit");
  if (isFileAccessDenied(grant)) return fileAccessDeniedError(command, grant);
  const result = await runWithEditGrants(deps.fileAccess, [grant], operation);
  if (result.ok) return result.value;
  return fileAccessDeniedError(command, firstRefusal(result.refusal));
}

/** Whether the agent may create in the folder a path names; undefined when it names no owner. */
export async function containerReadonly(
  deps: Pick<ToolWiringDeps, "fileAccess" | "works">,
  principal: Principal,
  context: ResolvedModelContextPort,
  path: string,
): Promise<boolean | undefined> {
  const target = await threadContainerTarget(deps.works, context.resolution, path);
  if (!target) return undefined;
  return isFileAccessDenied(await deps.fileAccess.authorize(principal, target, "edit"));
}

/** A partial undo or redo says which writes stayed, and why, after what it reversed. */
export function withRefusedWrites(outcome: RoutedWriteOutcome) {
  const { refusedWrites, ...written } = outcome;
  if (!refusedWrites?.length) return written;
  const verb = written.command === "redo" ? "redone" : "undone";
  const notes = refusedWrites.map(({ writeIds, denial }) => {
    const why = isPermissionDenial(denial)
      ? permissionDeniedMessage(denial)
      : deletedFileMessage("reversal");
    if (writeIds.length === 0) return why;
    return `${writeIds.join(", ")} ${writeIds.length === 1 ? "wasn't" : "weren't"} ${verb}. ${why}`;
  });
  const [first] = refusedWrites;
  return {
    ...written,
    result: {
      ...written.result,
      ...(first && isPermissionDenial(first.denial) ? { reason: first.denial.reason } : {}),
      message: [written.result.message, ...notes].filter(Boolean).join("\n\n"),
    },
  };
}
