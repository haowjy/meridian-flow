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
import type { ReturnedWhy } from "@meridian/contracts/commands";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";
import type { ThreadExecutionContext } from "@meridian/contracts/works";
import {
  type FileAccessDenied,
  type FileDestination,
  type FileEditRefusedError,
  type FileGrant,
  type FileNeed,
  type FileTarget,
  isDrafted,
  isFileAccessDenied,
  type Principal,
  runWithEditGrants,
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
      projectId: thread.projectId as ProjectId,
      chain: await deps.readAgentChain(thread.id as ThreadId),
      branchOwner: { owner: execution.branchOwner, handle: execution.scope.workHandle },
      writeMode: execution.aiWriteMode,
    },
  };
}

/**
 * Where an explicit `version: "draft"` read goes: the draft the Work kept of the document, so the
 * result says `draft`. A document whose content source can't hold a draft (its `contentScheme`
 * from the grant's facts, which a move keeps apart from its address), or one with none kept,
 * reads where its access sends it, as `draft` always did there.
 */
export async function keptDraft(
  deps: Pick<ToolWiringDeps, "branches">,
  grant: Pick<FileGrant, "facts">,
  documentId: string,
  execution: ThreadExecutionContext,
): Promise<FileDestination | null> {
  if (!isDrafted(grant.facts.contentScheme)) return null;
  const owner = execution.branchOwner;
  const drafts = await deps.branches.draftReview.list({ owner });
  return drafts.some((draft) => draft.documentId === documentId)
    ? { kind: "draft", owner, ownerHandle: execution.scope.workHandle }
    : null;
}

/**
 * The file policy's grant on a document, at the destination its access gives or at `at`; a
 * denial comes back as the tool's error.
 */
export async function documentGrant<N extends FileNeed>(
  deps: Pick<ToolWiringDeps, "fileAccess" | "documentRemovals">,
  principal: Principal,
  command: DocumentCommandName,
  address: Pick<ResolvedDocumentAddress, "documentId" | "filePath">,
  need: N,
  at?: FileDestination,
): Promise<FileGrant<N> | WriteToolErrorOutput> {
  const target = { kind: "document", documentId: address.documentId as never } as const;
  const grant = at
    ? await deps.fileAccess.authorizeAt(principal, target, at, need)
    : await deps.fileAccess.authorize(principal, target, need);
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

/**
 * Why a refused text edit is returned instead of refused: its Work is archived or deleted (the
 * files read, and take no new words), or its document was removed. Null: the refusal is who is
 * acting, or the file never existed.
 */
export function returnedWhy(
  denial: FileAccessDenied,
  removal: DocumentRemovalRecord | undefined,
): ReturnedWhy | null {
  if (isPermissionDenial(denial)) return denial.reason === "work_archived" ? "work_archived" : null;
  if (denial.reason === "work_deleted") return "work_deleted";
  return removal ? "document_removed" : null;
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
  at?: FileDestination,
): Promise<boolean | undefined> {
  const target = await threadContainerTarget(context.resolution, path);
  if (!target) return undefined;
  const grant = at
    ? await deps.fileAccess.authorizeAt(principal, target, at, "edit")
    : await deps.fileAccess.authorize(principal, target, "edit");
  return isFileAccessDenied(grant);
}

/** A `version: "live"` read of a listing or search: its documents are decided live, not in a draft. */
export function liveListing(version: "draft" | "live" | undefined): FileDestination | undefined {
  return version === "live" ? { kind: "live" } : undefined;
}
