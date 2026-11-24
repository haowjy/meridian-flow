import type { ResponseAuthorship } from "@meridian/contracts";
import type { SpliceFallback } from "../links/find-splice.js";
// Engine-facing read and write contract types for the agent editing core.

import type { LinkView } from "@meridian/contracts";
import type { Block } from "../codec-types.js";
import type { FrontierLookups, ObservationFrontier } from "../frontier.js";
import type { ShownLink } from "../links/correspondence.js";
import type { LinkShowing } from "../links/shown.js";
import type { DocumentCommandName, ReadCommand, WriteCommand } from "./command-schema.js";
import type { AgentEditResultCommand, AgentEditResultV1, WriteStatus } from "./model-result.js";

export type {
  DocumentCommandName,
  ReadCommand,
  WriteCommand,
  WriteCommandName,
} from "./command-schema.js";
export type {
  UndoOutcome,
  WriteErrorStatus,
  WriteStatus,
} from "./model-result.js";
/** Structured tool result with the exact LLM-facing text kept separate from host status. */
export type WriteOutcome = WriteOutcomeBase & { status: WriteStatus };

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
   * Host-only: a `create` without overwrite found text in its document and wrote nothing. The
   * host makes another document of that name (a twin) and writes there instead. Never copied
   * into `result`.
   */
  occupied?: true;
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
  threadId: string;
  turnId?: string;
  responseId?: string;
  toolUseId?: string;
}

/** Hidden host/session context; not part of the LLM command params. */
export interface WriteContext {
  /** Attribution and safety policy for mutating commands. */
  actor?: MutationActor;
  /** The writing thread, where `actor` names none: its writes' handles and edit list are its own. */
  threadId?: string;
  /** Host turn id for undo metadata; cross-call turn grouping is completed above this API later. */
  turnId?: string;
  /** The tool call's id: it scopes the write's durable id within its turn. */
  tool_use_id?: string;
  /** The response the write is authored in. */
  responseIdentity?: ResponseAuthorship;
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
   * The link view the host routed this command to: the Work draft or live
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

export interface LinkSpliceFallbackDetail {
  documentId: string;
  reason: SpliceFallback;
}

/** An observation frontier could not be computed; the result goes out without it. */
export interface ObservationFailedDetail {
  documentId: string;
  cause: unknown;
}
