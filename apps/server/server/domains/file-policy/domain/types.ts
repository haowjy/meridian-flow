/**
 * File-policy vocabulary (file-access §2, §3, §3.1): who asks, what they ask
 * about, the facts the policy decides on, and the grant it returns.
 */
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
}

/** `[calling thread, its parent, …, root]`. Each link caps the result (D8). */
export type AgentChain = readonly AgentLink[];

/** A Work as refusal copy names it. */
export interface WorkRef {
  id: WorkId;
  slug: string | null;
}

/**
 * Who is asking. A person acts alone; an agent acts for the person, under its
 * delegation chain, and in draft mode routes drafted sources to `draftWork`.
 */
export interface Principal {
  accountId: UserId;
  agent?: {
    chain: AgentChain;
    /** The Work whose draft drafted sources land in; null outside draft mode. */
    draftWork: WorkRef | null;
  };
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** The skills a thread's own binding names (D52), as the skill rule reads them. */
export interface SkillFacts {
  /** `skills.load`: preloaded, readable whatever their `model-invocable`. */
  load: readonly string[];
  /** `skills.available`, each with its `model-invocable` flag. */
  available: readonly { slug: string; modelInvocable: boolean }[];
}

// ---------------------------------------------------------------------------
// Targets and facts
// ---------------------------------------------------------------------------

export type FileOwnerRef =
  | { scope: "project"; projectId: ProjectId }
  | { scope: "work"; workId: WorkId };

/**
 * What a request is about. AI calls pass `document` and the policy picks live
 * or draft; `draft` is for the writer's draft preview, Apply and Discard.
 */
export type FileTarget =
  | { kind: "document"; documentId: DocumentId }
  | { kind: "draft"; documentId: DocumentId; workId: WorkId }
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
  slug: string | null;
  isNoWork: boolean;
  archived: boolean;
  deleted: boolean;
}

/** Everything the policy decides on, loaded by the `FileFacts` port. */
export interface FileFacts {
  target: FileTarget;
  projectId: ProjectId;
  ownerAccountId: UserId;
  projectDeleted: boolean;
  /** The Work owning the file's source; null when the project owns it. */
  ownerWork: FileWorkFacts | null;
  /** The document, a folder above it, or its source is deleted. */
  deleted: boolean;
  scheme: ContextUriScheme;
  /** The document itself; null for a container. */
  self: FileNode | null;
  /** Nearest first: folders up to the source, the source, the owning Work, the project. */
  ancestors: readonly FileNode[];
  /** The Work whose draft this access goes through, when one was asked about. */
  draftWork?: FileWorkFacts;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Where a write lands: the live document, or a Work's draft (D20). */
export type FileDestination =
  | { kind: "live" }
  | { kind: "draft"; workId: WorkId; workSlug: string | null };

/** The reason a transport reports (§9); the wire type. A deleted file is `not_found`. */
export type { FileAccessDenial };

export interface FileDecision {
  level: FileAccessLevel;
  /** The term that held the level below `edit`, in precedence order. */
  limitedBy: FileAccessDenial | null;
  /** Set for `work_archived`: the archived Work, for refusal copy. */
  archivedWork: WorkRef | null;
  destination: FileDestination;
}

export type FileNeed = "read" | "edit";

declare const fileGrantBrand: unique symbol;

/**
 * Proof that a principal may `N` a target, minted only by the file-access
 * service. `FileGrant<"edit">` satisfies `FileGrant<"read">`.
 */
export interface FileGrant<N extends FileNeed = FileNeed> {
  readonly [fileGrantBrand]: N extends "edit" ? { read: true; edit: true } : { read: true };
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
 * The named Works a write to this file locks (§5): its owner and its draft's
 * Work. The project and No Work can't be archived, so they lock nothing.
 */
export function grantWorkIds(facts: FileFacts): WorkId[] {
  const ids: WorkId[] = [];
  if (facts.ownerWork && !facts.ownerWork.isNoWork) ids.push(facts.ownerWork.id);
  if (facts.draftWork && !facts.draftWork.isNoWork) ids.push(facts.draftWork.id);
  return ids;
}

export function isFileAccessDenied(value: unknown): value is FileAccessDenied {
  return (
    typeof value === "object" && value !== null && (value as { denied?: unknown }).denied === true
  );
}
