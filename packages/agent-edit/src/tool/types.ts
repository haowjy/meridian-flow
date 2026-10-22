import type { ModelResponseIdentity } from "@meridian/contracts";
// Engine-facing read and write contract types for the agent editing core.

import type { LinkView } from "@meridian/contracts";
import type { Block } from "../codec-types.js";
import type { FrontierLookups, ObservationFrontier } from "../frontier.js";
import type { ShownLink } from "../links/correspondence.js";
import type { LinkShowing } from "../links/shown.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { DocumentCommandName, ReadCommand, WriteCommand } from "./command-schema.js";
import type {
  AgentEditResultCommand,
  AgentEditResultV1,
  WriteStatus,
  WriteSuccessPhase,
} from "./model-result.js";

export type {
  DocumentCommandName,
  ReadCommand,
  WriteCommand,
  WriteCommandName,
} from "./command-schema.js";
export type {
  UndoRedoOutcome,
  WriteErrorStatus,
  WriteStatus,
  WriteSuccessPhase,
} from "./model-result.js";
export type UndoCommand = Extract<WriteCommand, { command: "undo" }>;
export type RedoCommand = Extract<WriteCommand, { command: "redo" }>;
/** Structured tool result with the exact LLM-facing text kept separate from host status. */
export type WriteOutcome = WriteOutcomeBase &
  ({ status: "success"; phase: WriteSuccessPhase } | { status: Exclude<WriteStatus, "success"> });

interface WriteOutcomeBase {
  /** Host-only identity; never included in the model result. */
  revision: string | null;
  command: AgentEditResultCommand;
  isError: boolean;
  /** Stable model-facing write handle for successful mutating writes, e.g. e3. */
  writeId?: string;
  /** Unique host-only correlation for replacing a staged result with its settled receipt. */
  settlementId?: string;
  /** Machine-readable error detail for host observability; the model reads the rendered `result`. */
  error?: WriteErrorDetail;
  /** The typed result; `renderAgentEditResult` makes the model's text from it. */
  result: AgentEditResultV1;
  /** Host-only: the blocks a read selected, when the read asked for `includeNodes`. */
  nodes?: readonly Block[];
  /**
   * Host-only showing evidence: each link the rendered result showed the
   * model, with the address shown (truncated blocks count only links ending
   * inside the shown prefix), and the holder URI and view it was spelled
   * from. Never copied into `result`.
   */
  showing?: LinkShowing;
  /**
   * Host-only: the frontier of what this result showed, in the room its door
   * named, present when the caller passed `WriteContext.frontiers`. Never
   * copied into `result`.
   */
  frontier?: ObservationFrontier;
}

export type ResponseLifecycleOperation = "stage" | "commit" | "rollback";
export type ResponseLifecycleClosedState = "committed" | "rolledBack";

export interface ResponseLifecycleErrorDetail {
  type: "response_lifecycle";
  code: "response_closed";
  responseId: string;
  operation: ResponseLifecycleOperation;
  state: ResponseLifecycleClosedState;
  documentId?: string;
  threadId?: string;
  turnId?: string;
  writeId?: string;
}

/**
 * A mutation-bearing write claimed for a document was dropped from an open
 * response by thread invalidation while other documents in the same response
 * stayed staged and eventually committed. The model already saw `tool_result
 * status: "success"` for the dropped write; this event makes the non-durability
 * loud alongside the durable commit of the survivors.
 */
export interface ResponseClaimDiscardedEntry {
  documentId: string;
  threadId: string;
  updateCount: number;
}

export interface ResponseLifecycleClaimDiscardedDetail {
  type: "response_lifecycle";
  code: "claimed_write_discarded";
  responseId: string;
  documents: readonly ResponseClaimDiscardedEntry[];
}

/** Host observability when a tool_use_id replay returns a cached write outcome. */
export interface WriteIdempotencyHitDetail {
  toolUseId: string;
  scopeKind: "response" | "turn" | null;
  scopeId: string | null;
  sessionId: string;
  outcome:
    | { status: "success"; phase: WriteSuccessPhase }
    | { status: Exclude<WriteStatus, "success"> };
}

/** Host-only evidence for a dispatch failure collapsed to the stable internal-error outcome. */
export interface UnexpectedWriteErrorDetail {
  cause: unknown;
  command: DocumentCommandName;
  documentId?: string;
  sessionId: string;
  threadId: string;
  turnId?: string;
  responseId?: string;
  toolUseId?: string;
}

export type ResponseLifecycleEvent =
  | ResponseLifecycleErrorDetail
  | ResponseLifecycleClaimDiscardedDetail;

export type ResponseCommitterPhase = "buffered" | "journalStaged" | "closed";

export type ResponseCommitterTransition =
  | "stage"
  | "drop_for_thread"
  | "journal_staged"
  | "document_saved"
  | "closed"
  | "rollback"
  | "evicted";

export interface ResponseCommitterTransitionDetail {
  type: "response_committer";
  transition: ResponseCommitterTransition;
  responseId: string;
  phase: ResponseCommitterPhase;
  closedOutcome?: ResponseLifecycleClosedState;
  documentId?: string;
  threadId?: string;
  droppedUpdateCount?: number;
}

export type WriteErrorDetail = ResponseLifecycleErrorDetail;

export type InteractionContext =
  | { mode: "live" }
  | {
      /** A draft-mode write, bound to its thread peer's identity before its room read. */
      mode: "threadPeer";
      /** Host peer identity, for exact retirement independently of generation replay. */
      peerDraftId?: string;
      upstreamDraftId?: string;
    };

/** Hidden host/session context; not part of the LLM command params. */
export interface WriteContext {
  /** Attribution and safety policy for mutating commands. */
  actor?: MutationActor;
  /** Stable session supplied directly by embedded callers. */
  session?: ActorSession;
  /** External identity resolved through ActorSessionStore when configured. */
  externalId?: string;
  /** Convenience identity for server-local callers that do not need an ActorSessionStore. */
  sessionId?: string;
  /** Convenience thread override for server-local callers. */
  threadId?: string;
  /** Host turn id for undo metadata; cross-call turn grouping is completed above this API later. */
  turnId?: string;
  /** Host/tool-call idempotency key. Replays return the original outcome. */
  tool_use_id?: string;
  /** Immutable provider authorship and the independently rotated prepared scope. */
  responseIdentity?: ModelResponseIdentity;
  /**
   * Host-captured interaction identity: baseline, journal floor, draft
   * generation, and optional attempt guard travel as one object.
   */
  interactionContext?: InteractionContext;
  /** Host-routed: the Work draft a draft read bound to no peer reads (`DocumentAccess.workDraftId`). */
  workDraftId?: string;
  /** Version requested at the routing boundary, independent of the view used to render links. */
  documentVersion?: "live" | "draft";
  /** The writing thread's top chat handle: bare `uploads://` links written fresh are stored qualified to it. */
  uploadsChat?: string;
  /** True only when the host resolved this create to a previously missing document. */
  createdDocument?: boolean;
  /** A read also returns the selected blocks as nodes (`WriteOutcome.nodes`), for a copy. */
  includeNodes?: boolean;
  /**
   * The blocks a `from` or `copy` write copies, read by the host from the
   * source (D23, D24). They become the command's content as nodes.
   */
  copiedNodes?: readonly Block[];
  /**
   * A host's whole-document write, bound outside its transaction (§6.2): the
   * `create` command's content as nodes whose refs are assigned and whose
   * ahead refs are registered. Nothing is parsed or assigned again; an
   * overwrite aligns them against the document as it is when applied.
   */
  boundNodes?: readonly Block[];
  /**
   * Host-only showing evidence for this thread: every link the model was
   * shown in a document, with the address shown. Ref assignment reads it;
   * agent-edit never reads thread history itself. Absent for utility, seed
   * and import writes (fresh ref assignment by design).
   */
  shownLinks?: (documentId: string) => Promise<readonly ShownLink[]>;
  /**
   * Host-only: the model's frontier lookups for this call. A result that shows
   * document text records its frontier in the room its door named, chained from
   * `recording`; a write plans on `planning`'s frontier there. Absent for
   * callers that record no frontier.
   */
  frontiers?: FrontierLookups;
  /**
   * The link view the host routed this command to: the Work branch or live
   * version its destination names. A host that routes between versions sets
   * it on every command; links, sources and the revision spell in it.
   */
  linkView?: LinkView;
}

export type MutationActor =
  | { kind: "agent"; turnId: string; threadId: string; responseId?: string; editScopeId?: string }
  | { kind: "human"; userId: string; threadId?: string }
  | { kind: "system"; origin: string };

export type ReadFunction = (command: ReadCommand, context?: WriteContext) => Promise<WriteOutcome>;
export type WriteFunction = (
  command: WriteCommand,
  context?: WriteContext,
) => Promise<WriteOutcome>;

export interface ResponseCommitDocumentResult {
  documentId: string;
  updateCount: number;
  receipts: ResponseCommitWriteReceipt[];
  lateSweep?: import("./commit-detection.js").DestructiveSweepReport;
  /**
   * Host-only, when the commit asked (`ResponseCommitOptions.recordingFrontier`):
   * the frontier at the save's after-state, crediting every accepted receipt and what the last
   * one lists.
   */
  frontier?: ObservationFrontier;
}

export interface ResponseCommitWriteReceipt {
  revision: string | null;
  writeId: string;
  settlementId: string;
  result: AgentEditResultV1;
  /** Host-only: what the settled receipt's echo showed the model, from the commit's own links. */
  showing?: LinkShowing;
}

export interface ResponseStagedCreateOutcome {
  committed: string[];
  discarded: string[];
}

export interface ResponseCommitSuccessResult {
  status: "committed";
  responseId: string;
  documentCount: number;
  updateCount: number;
  documents: ResponseCommitDocumentResult[];
  stagedCreates: ResponseStagedCreateOutcome;
  /** Recovery committed the journal but could not verify concurrent-content awareness. */
  awarenessDegraded?: boolean;
  /**
   * Mutation-bearing writes the model was already told succeeded, dropped
   * before commit by a per-doc `dropForThread`, while other docs in this
   * response committed durably. Always non-empty when the
   * `claimed_write_discarded` lifecycle event fires.
   */
  discardedClaims?: readonly ResponseClaimDiscardedEntry[];
}

export interface ResponseRollbackResult {
  status: "rolledBack";
  responseId: string;
  stagedCreates: ResponseStagedCreateOutcome;
}
