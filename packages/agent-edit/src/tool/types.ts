import type { ResponseAuthorship } from "@meridian/contracts";
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
  /** The typed result; `renderAgentEditResult` makes the model's text from it. */
  result: AgentEditResultV1;
  /** Host-only: the blocks a read selected, when the read asked for `includeNodes`. */
  nodes?: readonly Block[];
  /** Host-only: where each settled `ahead:` ref in `nodes` points, read with `nodes` (`includeNodes`). */
  aheadSettlements?: ReadonlyMap<string, string>;
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
  /** The tool call's id: it scopes the write's durable id within its turn. */
  tool_use_id?: string;
  /** The response the write is authored in. */
  responseIdentity?: ResponseAuthorship;
  /** Host-routed: the Work draft a draft call reads and saves (`DocumentAccess.workDraftId`). */
  workDraftId?: string;
  /** Version requested at the routing boundary, independent of the view used to render links. */
  documentVersion?: "live" | "draft";
  /** The writing thread's top chat handle: bare `uploads://` links written fresh are stored qualified to it. */
  uploadsChat?: string;
  /** A read also returns the selected blocks as nodes (`WriteOutcome.nodes`), for a copy. */
  includeNodes?: boolean;
  /**
   * The blocks a `from` or `copy` write copies, read by the host from the
   * source. They become the command's content as nodes.
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
  | { kind: "agent"; turnId: string; threadId: string; responseId?: string }
  | { kind: "human"; userId: string; threadId?: string }
  | { kind: "system"; origin: string };

export type ReadFunction = (command: ReadCommand, context?: WriteContext) => Promise<WriteOutcome>;
export type WriteFunction = (
  command: WriteCommand,
  context?: WriteContext,
) => Promise<WriteOutcome>;
