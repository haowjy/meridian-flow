import type { DraftId, DraftOwner } from "@meridian/contracts";
import type { AgentPermission } from "@meridian/contracts/agents";
import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import type { FileAccessDenial } from "@meridian/contracts/protocol";
import type {
  ContextSourceId,
  DocumentId,
  FolderId,
  ProjectId,
  ThreadId,
  UserId,
  WorkId,
} from "@meridian/contracts/runtime";
import type { AiWriteMode } from "@meridian/contracts/works";
import type { OwnerLocks } from "../../../shared/draft-owner.js";
import type { TreeList } from "../../context/ports/tree-list-store.js";

export type FileAccessLevel = "none" | "read" | "edit";

const LEVEL_RANK: Readonly<Record<FileAccessLevel, number>> = { none: 0, read: 1, edit: 3 };

export function atLeast(level: FileAccessLevel, need: FileAccessLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[need];
}

export function lowerLevel(a: FileAccessLevel, b: FileAccessLevel): FileAccessLevel {
  return LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b;
}

export function higherLevel(a: FileAccessLevel, b: FileAccessLevel): FileAccessLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

export interface AgentLink {
  threadId: ThreadId;
  permission: AgentPermission;
  threadWorkId: WorkId;
  scratchOwner: import("../../context/scratch-owner.js").ScratchOwner;
}

export type AgentChain = readonly AgentLink[];

export interface WorkRef {
  id: WorkId;
  handle: string | null;
}

export interface DraftOwnerRef {
  owner: DraftOwner;
  draftId: DraftId;
  handle: string | null;
}

export interface Principal {
  accountId: UserId;
  agent?: {
    projectId: ProjectId;
    chain: AgentChain;
    draftOwner: DraftOwnerRef;
    writeMode: AiWriteMode;
  };
}

export type AiAccess = "auto-apply" | "ask" | "deny";

export interface AiAccessSetting {
  node: FileNode;
  access: AiAccess;
}

export interface SkillFacts {
  load: readonly string[];
  available: readonly { slug: string; modelInvocable: boolean }[];
  invoked: readonly string[];
}

export type FileOwnerRef =
  | { scope: "project"; projectId: ProjectId }
  | { scope: "account"; userId: UserId }
  | { scope: "work"; workId: WorkId }
  | { scope: "lineage"; projectId: ProjectId; rootThreadId: ThreadId }
  | { scope: "chat"; projectId: ProjectId; threadId: ThreadId };

export type FileTarget =
  | { kind: "document"; documentId: DocumentId }
  | { kind: "draft"; documentId: DocumentId; draftId: DraftId }
  | { kind: "restore"; documentId: DocumentId }
  | { kind: "container"; scheme: ContextUriScheme; owner: FileOwnerRef };

export type FileNode =
  | { kind: "document"; id: DocumentId }
  | { kind: "folder"; id: FolderId }
  | { kind: "source"; id: ContextSourceId }
  | { kind: "work"; id: WorkId }
  | { kind: "project"; id: ProjectId }
  | { kind: "account"; id: UserId };

export interface FileWorkFacts {
  id: WorkId;
  handle: string | null;
  isNoWork: boolean;
  archived: boolean;
  deleted: boolean;
}

export interface FileDraftOwnerFacts {
  draftId: DraftId;
  owner: DraftOwner | null;
  handle: string | null;
  isNoWork: boolean;
  archived: boolean;
  deleted: boolean;
  purged: boolean;
  frozen: boolean;
}

export interface FileFacts {
  target: FileTarget;
  owner: TreeList;
  ownerAccountId: UserId;
  projectDeleted: boolean;
  ownerWork: FileWorkFacts | null;
  ownerRootThreadId?: ThreadId | null;
  ownerChatThreadId?: ThreadId | null;
  deleted: boolean;
  /**
   * `deleted` is the document's own delete or its folder's, and `draftOwner`'s draft has an
   * active Work draft of it, which outlived that delete: a draft destination in that
   * draft stays open. Never set from the draft's pending effect.
   */
  survivingDraft?: boolean;
  scheme: ContextUriScheme;
  contentScheme: ContextUriScheme;
  self: FileNode | null;
  ancestors: readonly FileNode[];
  aiAccessSettings?: readonly AiAccessSetting[];
  draftOwner?: FileDraftOwnerFacts;
}

export type FileDestination =
  | { kind: "live" }
  | { kind: "draft"; draftId: DraftId; ownerHandle: string | null };

export type { FileAccessDenial };

export interface FileDecision {
  level: FileAccessLevel;
  limitedBy: FileAccessDenial | null;
  archivedWork: WorkRef | null;
  destination: FileDestination;
  command: boolean;
}

export type FileNeed = "read" | "edit" | "command";

declare const fileGrantBrand: unique symbol;

export interface FileGrant<N extends FileNeed = FileNeed> {
  readonly [fileGrantBrand]: N extends "edit"
    ? { read: true; edit: true }
    : N extends "command"
      ? { read: true; command: true }
      : { read: true };
  readonly need: FileNeed;
  readonly principal: Principal;
  readonly facts: FileFacts;
  readonly destination: FileDestination;
}

export interface FileAccessDenied {
  readonly denied: true;
  readonly target: FileTarget;
  readonly reason: FileAccessDenial;
  readonly level: FileAccessLevel;
  readonly archivedWork: WorkRef | null;
  readonly facts: FileFacts | null;
  readonly destination: FileDestination | null;
}

export function targetDocumentId(target: FileTarget): DocumentId {
  if (target.kind === "container") throw new Error("A container target names no document");
  return target.documentId;
}

export function grantOwnerLocks(facts: FileFacts): OwnerLocks {
  const workIds: string[] = [];
  const lineageRootIds: string[] = [];
  if (facts.ownerWork && !facts.ownerWork.isNoWork) workIds.push(facts.ownerWork.id);
  const draftOwner = facts.draftOwner;
  if (draftOwner?.owner && !draftOwner.isNoWork) {
    if (draftOwner.owner.kind === "work") workIds.push(draftOwner.owner.workId);
    else lineageRootIds.push(draftOwner.owner.rootThreadId);
  }
  return { workIds, lineageRootIds };
}

export type { OwnerLocks };

export function agentProject(grant: Pick<FileGrant, "principal">): ProjectId {
  const projectId = grant.principal.agent?.projectId;
  if (!projectId) throw new Error("The grant is not an agent's");
  return projectId;
}

export function agentDraftOwner(principal: Principal): DraftOwnerRef {
  const ref = principal.agent?.draftOwner;
  if (!ref) throw new Error("The principal is not an agent");
  return ref;
}

export function ownerNode(owner: TreeList): FileNode {
  return owner.kind === "project"
    ? { kind: "project", id: owner.projectId as ProjectId }
    : { kind: "account", id: owner.userId as UserId };
}

export function isFileAccessDenied(value: unknown): value is FileAccessDenied {
  return (
    typeof value === "object" && value !== null && (value as { denied?: unknown }).denied === true
  );
}
