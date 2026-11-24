/**
 * File-policy vocabulary (file-access §2, §3, §3.1): who asks, what they ask
 * about, the facts the policy decides on, and the grant it returns.
 */

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

/**
 * The draft an agent's drafts land in, the owner naming it (its chat's Work, or its lineage),
 * whose lifecycle stops new AI writes, and the handle refusal copy names it by.
 */
export interface DraftOwnerRef {
  owner: DraftOwner;
  draftId: DraftId;
  handle: string | null;
}

/**
 * Who is asking. A person acts alone; an agent acts for the person, under its
 * delegation chain. Its drafts go to `draftOwner` in either mode; `writeMode` says whether
 * every drafted source drafts (`draft`), or only the places that ask for review do.
 */
export interface Principal {
  accountId: UserId;
  agent?: {
    /**
     * The project the agent's thread runs in: where its draft is and what its links read in.
     * Never the file's project (`FileFacts.owner`), which for a home document is none.
     */
    projectId: ProjectId;
    chain: AgentChain;
    draftOwner: DraftOwnerRef;
    writeMode: AiWriteMode;
  };
}

/**
 * What a place does with an AI write: `auto-apply` lands it, `ask` lands it as a draft for the
 * writer to Apply, `deny` leaves the place read-only to the AI.
 */
export type AiAccess = "auto-apply" | "ask" | "deny";

/** A setting on a node of the live tree. */
export interface AiAccessSetting {
  node: FileNode;
  access: AiAccess;
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
  /** The account's own: its home folder. */
  | { scope: "account"; userId: UserId }
  | { scope: "work"; workId: WorkId }
  | { scope: "lineage"; projectId: ProjectId; rootThreadId: ThreadId }
  | { scope: "chat"; projectId: ProjectId; threadId: ThreadId };

/**
 * What a request is about. AI calls pass `document` and the policy picks live
 * or draft; `draft` is for the writer's draft preview, Apply and Discard;
 * `restore` is a document that may be in Trash: where an inverse would bring it back, and
 * the text room, which takes text until the node is purged. Restore admission reads through
 * document and folder tombstones because placement revives that chain; source, project,
 * owner-Work, and ownership lifecycle still apply. A `draft` with `restore` is that restore in
 * a Work's draft: it reads through live's Trash as a live restore does, and the Work's and
 * owner's lifecycle still apply.
 */
export type FileTarget =
  | { kind: "document"; documentId: DocumentId }
  | { kind: "draft"; documentId: DocumentId; draftId: DraftId }
  | { kind: "restore"; documentId: DocumentId }
  | { kind: "container"; scheme: ContextUriScheme; owner: FileOwnerRef };

/** A node of the file tree that grants and future agent rules attach to. */
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

/**
 * The lifecycle of whoever names a draft: a Work as `FileWorkFacts` reads it, or a lineage, which
 * is `frozen` while no chat in it is live.
 */
export interface FileDraftOwnerFacts {
  draftId: DraftId;
  /** The Work or lineage naming the draft; null when the draft or its owner is gone. */
  owner: DraftOwner | null;
  handle: string | null;
  isNoWork: boolean;
  archived: boolean;
  deleted: boolean;
  /** The owner's row is gone: a Work purged for good, or a lineage whose root is. */
  purged: boolean;
  frozen: boolean;
}

/** Everything the policy decides on, loaded by the `FileFacts` port. */
export interface FileFacts {
  target: FileTarget;
  /** Who owns the file: a project, or the account for a home document. */
  owner: TreeList;
  /** The account the owner answers to: the project's owner, or the account itself. */
  ownerAccountId: UserId;
  /** The owning project is deleted; never for an account's file. */
  projectDeleted: boolean;
  /** The Work owning the file's source; null when the project owns it. */
  ownerWork: FileWorkFacts | null;
  ownerRootThreadId?: ThreadId | null;
  /** The chat that received an upload; set only for a `chat` source's documents. */
  ownerChatThreadId?: ThreadId | null;
  /** The document, a folder above it, or its source is deleted. */
  deleted: boolean;
  /**
   * `deleted` is the document's own delete or its folder's, and `draftOwner`'s draft has an
   * active Work draft of it, which outlived that delete: a draft destination in that
   * draft stays open. Never set from the draft's pending effect.
   */
  survivingDraft?: boolean;
  scheme: ContextUriScheme;
  /** The durable content source; draft moves change `scheme`, never this routing fact. */
  contentScheme: ContextUriScheme;
  /** The document itself; null for a container. */
  self: FileNode | null;
  /** Nearest first: folders up to the source, the source, the owning Work, the project or account. */
  ancestors: readonly FileNode[];
  /**
   * The settings on the file and its folders, source and Work in the *live* tree, nearest first;
   * never a draft's view, or a draft move of a file out of a `deny` folder would escape it.
   * The policy takes the first. Absent until settings are stored.
   */
  aiAccessSettings?: readonly AiAccessSetting[];
  /** The draft this access goes through and its owner, when one was asked about. */
  draftOwner?: FileDraftOwnerFacts;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Where a write lands: the live document, or an owner's draft. */
export type FileDestination =
  | { kind: "live" }
  | { kind: "draft"; draftId: DraftId; ownerHandle: string | null };

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
   * Whether the principal may run a document command (Apply, Un-Apply, Discard, Undo of a
   * Discard) here: `edit` ignoring the lifecycle terms. A closed owner is the command's own
   * answer to give, under the Work lock.
   */
  command: boolean;
}

export type FileNeed = "read" | "edit" | "command";

declare const fileGrantBrand: unique symbol;

/**
 * Proof that a principal may `N` a target, minted only by the file-access
 * service. `FileGrant<"edit">` and `FileGrant<"command">` each satisfy `FileGrant<"read">`.
 */
export interface FileGrant<N extends FileNeed = FileNeed> {
  readonly [fileGrantBrand]: N extends "edit"
    ? { read: true; edit: true }
    : N extends "command"
      ? { read: true; command: true }
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
}

/** The document a document or draft target names; a container names none. */
export function targetDocumentId(target: FileTarget): DocumentId {
  if (target.kind === "container") throw new Error("A container target names no document");
  return target.documentId;
}

/**
 * The named Works and the lineages a write to this file locks (§5): its owner and its draft's
 * owner. The project and No Work can't be archived, so they lock nothing.
 */
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

/** The project an agent's grant was asked in (its thread's); only an agent's grant has one. */
export function agentProject(grant: Pick<FileGrant, "principal">): ProjectId {
  const projectId = grant.principal.agent?.projectId;
  if (!projectId) throw new Error("The grant is not an agent's");
  return projectId;
}

/** The draft an agent's drafted writes land in, with its owner. */
export function agentDraftOwner(principal: Principal): DraftOwnerRef {
  const ref = principal.agent?.draftOwner;
  if (!ref) throw new Error("The principal is not an agent");
  return ref;
}

/** The node that stands for a file's owner, where its owner's grant attaches. */
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
