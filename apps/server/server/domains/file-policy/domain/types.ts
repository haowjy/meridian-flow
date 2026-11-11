/**
 * File-policy vocabulary (file-access §2, §3, §3.1): who asks, what they ask
 * about, the facts the policy decides on, and the grant it returns.
 */

import type { DraftOwner } from "@meridian/contracts";
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
import type { OwnerLocks } from "../../../shared/draft-owner.js";

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

/**
 * Ranked access levels. `comment` is reserved between `read` and `edit` for
 * sharing (§3.1); compare with `atLeast`, never by testing one value.
 */
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

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

/** One link of a delegation chain: a thread, its agent permission and its current Work. */
export interface AgentLink {
  threadId: ThreadId;
  permission: AgentPermission;
  /** The thread's current primary Work; follows `work switch`. */
  threadWorkId: WorkId;
  scratchOwner: import("../../context/scratch-owner.js").ScratchOwner;
}

/** `[calling thread, its parent, …, root]`. Each link caps the result. */
export type AgentChain = readonly AgentLink[];

/** A Work as refusal copy names it. */
export interface WorkRef {
  id: WorkId;
  handle: string | null;
}

/** The owner whose branch drafted writes land in, with the handle refusal copy names it by. */
export interface BranchOwnerRef {
  owner: DraftOwner;
  handle: string | null;
}

/**
 * Who is asking. A person acts alone; an agent acts for the person, under its
 * delegation chain, and in draft mode routes drafted sources to `branchOwner`.
 */
export interface Principal {
  accountId: UserId;
  agent?: {
    chain: AgentChain;
    /** The owner whose branch drafted sources land in; null outside draft mode. */
    branchOwner: BranchOwnerRef | null;
  };
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** The skills a thread's binding names or its user invoked, as the skill rule reads them. */
export interface SkillFacts {
  /** `skills.load`: preloaded, readable whatever their `model-invocable`. */
  load: readonly string[];
  /** `skills.available`, each with its `model-invocable` flag. */
  available: readonly { slug: string; modelInvocable: boolean }[];
  /** Packaged skills the user invoked with `/skill` in this thread. */
  invoked: readonly string[];
}

// ---------------------------------------------------------------------------
// Targets and facts
// ---------------------------------------------------------------------------

export type FileOwnerRef =
  | { scope: "project"; projectId: ProjectId }
  | { scope: "work"; workId: WorkId }
  | { scope: "lineage"; projectId: ProjectId; rootThreadId: ThreadId }
  | { scope: "chat"; projectId: ProjectId; threadId: ThreadId };

/**
 * What a request is about. AI calls pass `document` and the policy picks live
 * or draft; `draft` is for the writer's draft preview, Apply and Discard;
 * `restore` is a deleted document where an inverse would bring it back. Restore
 * admission reads through document and folder tombstones because placement revives
 * that chain; source, project, owner-Work, and ownership lifecycle still apply.
 */
export type FileTarget =
  | { kind: "document"; documentId: DocumentId }
  | { kind: "draft"; documentId: DocumentId; owner: DraftOwner }
  | { kind: "restore"; documentId: DocumentId }
  | { kind: "container"; scheme: ContextUriScheme; owner: FileOwnerRef };

/** A node of the file tree that grants and future agent rules attach to. */
export type FileNode =
  | { kind: "document"; id: DocumentId }
  | { kind: "folder"; id: FolderId }
  | { kind: "source"; id: ContextSourceId }
  | { kind: "work"; id: WorkId }
  | { kind: "project"; id: ProjectId };

export interface FileWorkFacts {
  id: WorkId;
  handle: string | null;
  isNoWork: boolean;
  archived: boolean;
  deleted: boolean;
}

/**
 * A branch owner's lifecycle: a Work as `FileWorkFacts` reads it, or a lineage, which is
 * `frozen` while no chat in it is live.
 */
export interface FileBranchOwnerFacts {
  owner: DraftOwner;
  handle: string | null;
  isNoWork: boolean;
  archived: boolean;
  deleted: boolean;
  frozen: boolean;
}

/** Everything the policy decides on, loaded by the `FileFacts` port. */
export interface FileFacts {
  target: FileTarget;
  projectId: ProjectId;
  ownerAccountId: UserId;
  projectDeleted: boolean;
  /** The Work owning the file's source; null when the project owns it. */
  ownerWork: FileWorkFacts | null;
  ownerRootThreadId?: ThreadId | null;
  /** The chat that received an upload; set only for a `chat` source's documents. */
  ownerChatThreadId?: ThreadId | null;
  /** The document, a folder above it, or its source is deleted. */
  deleted: boolean;
  /**
   * `deleted` is the document's own delete or its folder's, and `branchOwner`'s branch has an
   * active Work draft of it, which outlived that delete: a draft destination in that
   * branch stays open. Never set from the draft's pending effect.
   */
  survivingDraft?: boolean;
  scheme: ContextUriScheme;
  /** The durable content source; branch moves change `scheme`, never this routing fact. */
  contentScheme: ContextUriScheme;
  /** The document itself; null for a container. */
  self: FileNode | null;
  /** Nearest first: folders up to the source, the source, the owning Work, the project. */
  ancestors: readonly FileNode[];
  /** The owner whose branch this access goes through, when one was asked about. */
  branchOwner?: FileBranchOwnerFacts;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Where a write lands: the live document, or an owner's branch. */
export type FileDestination =
  | { kind: "live" }
  | { kind: "draft"; owner: DraftOwner; ownerHandle: string | null };

/** The reason a transport reports (§9); the wire type. A deleted file is `not_found`. */
export type { FileAccessDenial };

export interface FileDecision {
  level: FileAccessLevel;
  /** The term that held the level below `edit`, in precedence order. */
  limitedBy: FileAccessDenial | null;
  /** Set for `work_archived`: the archived Work, for refusal copy. */
  archivedWork: WorkRef | null;
  destination: FileDestination;
  /**
   * Whether the principal may throw this draft away: `edit` ignoring a frozen
   * lineage, which only holds back writes that keep a draft alive.
   */
  discard: boolean;
}

export type FileNeed = "read" | "edit" | "discard";

declare const fileGrantBrand: unique symbol;

/**
 * Proof that a principal may `N` a target, minted only by the file-access
 * service. `FileGrant<"edit">` and `FileGrant<"discard">` each satisfy `FileGrant<"read">`.
 */
export interface FileGrant<N extends FileNeed = FileNeed> {
  readonly [fileGrantBrand]: N extends "edit"
    ? { read: true; edit: true }
    : N extends "discard"
      ? { read: true; discard: true }
      : { read: true };
  /**
   * What `confirmEdit` re-checks. Typed `FileNeed`, not `N`, so a wider grant
   * still satisfies `FileGrant<"read">`; the brand alone carries `N`.
   */
  readonly need: FileNeed;
  readonly principal: Principal;
  /** What was granted; `facts.target` names it. */
  readonly facts: FileFacts;
  readonly destination: FileDestination;
}

/** A refused `authorize` or `confirmEdit`. */
export interface FileAccessDenied {
  readonly denied: true;
  readonly target: FileTarget;
  readonly reason: FileAccessDenial;
  /** The level the principal does have, `read` or `none`. */
  readonly level: FileAccessLevel;
  readonly archivedWork: WorkRef | null;
  /** The refused file's facts; null when it wasn't found. */
  readonly facts: FileFacts | null;
  readonly destination: FileDestination | null;
  /**
   * The asking agent's delegation chain, so refusal copy offers only calls
   * the action policy allows; null for a person.
   */
  readonly agentChain: AgentChain | null;
}

/** The document a document or draft target names; a container names none. */
export function targetDocumentId(target: FileTarget): DocumentId {
  if (target.kind === "container") throw new Error("A container target names no document");
  return target.documentId;
}

/**
 * The named Works and the lineages a write to this file locks (§5): its owner and its branch's
 * owner. The project and No Work can't be archived, so they lock nothing.
 */
export function grantOwnerLocks(facts: FileFacts): OwnerLocks {
  const workIds: string[] = [];
  const lineageRootIds: string[] = [];
  if (facts.ownerWork && !facts.ownerWork.isNoWork) workIds.push(facts.ownerWork.id);
  const branchOwner = facts.branchOwner;
  if (branchOwner && !branchOwner.isNoWork) {
    if (branchOwner.owner.kind === "work") workIds.push(branchOwner.owner.workId);
    else lineageRootIds.push(branchOwner.owner.rootThreadId);
  }
  return { workIds, lineageRootIds };
}

export type { OwnerLocks };

export function isFileAccessDenied(value: unknown): value is FileAccessDenied {
  return (
    typeof value === "object" && value !== null && (value as { denied?: unknown }).denied === true
  );
}
