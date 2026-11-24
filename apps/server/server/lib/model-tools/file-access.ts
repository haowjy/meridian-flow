import {
  DOCUMENT_NOT_FOUND_MESSAGE,
  type DocumentCommandName,
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
import { chatOwner } from "../../shared/draft-owner.js";
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
      draftOwner: {
        owner: chatOwner(thread, {
          id: execution.scope.workId,
          isNoWork: execution.scope.workHandle === null,
        }),
        draftId: execution.draftId,
        handle: execution.scope.workHandle,
      },
      writeMode: execution.aiWriteMode,
    },
  };
}

export async function keptDraft(
  deps: Pick<ToolWiringDeps, "drafts">,
  grant: Pick<FileGrant, "facts">,
  documentId: string,
  execution: ThreadExecutionContext,
): Promise<FileDestination | null> {
  if (!isDrafted(grant.facts.contentScheme)) return null;
  const draft = execution.draftId;
  const drafts = await deps.drafts.draftReview.list({ draft });
  return drafts.some((row) => row.documentId === documentId)
    ? { kind: "draft", draftId: draft, ownerHandle: execution.scope.workHandle }
    : null;
}

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

export function returnedWhy(
  denial: FileAccessDenied,
  removal: DocumentRemovalRecord | undefined,
): ReturnedWhy | null {
  if (isPermissionDenial(denial)) return denial.reason === "work_archived" ? "work_archived" : null;
  if (denial.reason === "work_deleted") return "work_deleted";
  return removal ? "document_removed" : null;
}

export function documentNotFoundError(
  command: DocumentCommandName,
  path?: string,
): WriteToolErrorOutput {
  const message = DOCUMENT_NOT_FOUND_MESSAGE;
  return {
    isError: true,
    output: modelResult({
      command,
      status: "document_not_found",
      payload: { ...(path ? { path } : {}), message },
    }),
  };
}

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

export function liveListing(version: "draft" | "live" | undefined): FileDestination | undefined {
  return version === "live" ? { kind: "live" } : undefined;
}
