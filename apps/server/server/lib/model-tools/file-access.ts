/**
 * The model tools' file-access adapter (file-access §1, §8): who a call acts
 * as, the grants it asks the file policy for, and a refusal as the tool's
 * error. Refusal copy lives in `file-access-denial-copy.ts`.
 */
import {
  type DocumentCommandName,
  documentNotFoundMessage,
  modelResult,
} from "@meridian/agent-edit/integration";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { ThreadExecutionContext } from "@meridian/contracts/works";
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
  isPermissionDenial,
  permissionDeniedMessage,
  removedFileResult,
} from "../file-access-denial-copy.js";
import { threadContainerTarget } from "../file-targets.js";
import type {
  ResolvedDocumentAddress,
  ResolvedModelContextPort,
  ToolWiringDeps,
  WriteToolErrorOutput,
} from "./tool-context.js";

/** The principal with its drafted writes routed to `work`'s drafts, or live for null. */
export function withBranchWork(principal: Principal, work: WorkRef | null): Principal {
  return principal.agent
    ? { ...principal, agent: { ...principal.agent, branchWork: work } }
    : principal;
}

/**
 * The agent a tool call acts as (file-access §8): the thread's person, its
 * delegation chain read fresh, and the Work whose drafts its drafted writes
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
      branchWork: execution.branchOwner
        ? { id: execution.branchOwner.workId, slug: execution.scope.workSlug }
        : null,
    },
  };
}

/**
 * An explicit `version: "draft"` outside draft mode reads the draft the Work
 * kept (a chat switched to auto-apply, or another chat writes drafts there; D62),
 * so the result says `draft`. With
 * no kept draft of this document it reads live, as `draft` always did there.
 */
export async function keptDraftReader(
  deps: Pick<ToolWiringDeps, "branches">,
  principal: Principal,
  execution: ThreadExecutionContext,
  documentId: string,
): Promise<Principal> {
  if (!principal.agent || principal.agent.branchWork || execution.branchOwner) return principal;
  const { workId, workSlug } = execution.scope;
  const drafts = await deps.branches.draftReview.list({ workId });
  if (!drafts.some((draft) => draft.documentId === documentId)) return principal;
  return withBranchWork(principal, { id: workId, slug: workSlug });
}

/** The file policy's grant on a document; a denial comes back as the tool's error. */
export async function documentGrant<N extends FileNeed>(
  deps: Pick<ToolWiringDeps, "fileAccess" | "documentRemovals">,
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
    ? fileAccessDeniedError(
        command,
        grant,
        address.filePath,
        await removalBehind(deps, principal, grant),
      )
    : grant;
}

/**
 * The removal record behind a `not_found` the principal could have read: a document id the
 * model already holds, whose file was removed. A reader without access learns nothing more.
 */
export async function removalBehind(
  deps: Pick<ToolWiringDeps, "fileAccess" | "documentRemovals">,
  principal: Principal,
  denial: FileAccessDenied,
): Promise<DocumentRemovalRecord | undefined> {
  if (isPermissionDenial(denial) || denial.target.kind !== "document") return undefined;
  const { documentId } = denial.target;
  if ((await deps.fileAccess.historyAccess(principal, documentId)) !== "deleted") return undefined;
  return (await deps.documentRemovals.lookup([documentId])).get(documentId);
}

/** A missing file as the tool's error. */
export function documentNotFoundError(
  command: DocumentCommandName,
  path?: string,
): WriteToolErrorOutput {
  const message = documentNotFoundMessage(command);
  return {
    isError: true,
    output: modelResult({
      command,
      status: "document_not_found",
      payload: { ...(path ? { path } : {}), message },
    }),
  };
}

/** A refused grant as the tool's error: `permission_denied` with its reason (§9). */
export function fileAccessDeniedError(
  command: DocumentCommandName,
  denial: FileAccessDenied,
  path?: string,
  removal?: DocumentRemovalRecord,
): WriteToolErrorOutput {
  if (!isPermissionDenial(denial))
    return removal
      ? removedFileResult(command, removal, path)
      : documentNotFoundError(command, path);
  const at = path ? { path } : {};
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
