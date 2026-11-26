import type { LinkView, ResponseAuthorship } from "@meridian/contracts";
import type { Block } from "../codec-types.js";
import type { FrontierLookups, ObservationFrontier } from "../frontier.js";
import type { ShownLink } from "../links/correspondence.js";
import type { SpliceFallback } from "../links/find-splice.js";
import type { LinkShowing } from "../links/shown.js";
import type { ActorSession } from "../ports/actor-session-store.js";
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
export type UndoCommand = Extract<WriteCommand, { command: "undo" }>;
export type WriteOutcome = WriteOutcomeBase & { status: WriteStatus };

interface WriteOutcomeBase {
  revision: string | null;
  command: AgentEditResultCommand;
  isError: boolean;
  writeId?: string;
  result: AgentEditResultV1;
  nodes?: readonly Block[];
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

export interface WriteContext {
  actor?: MutationActor;
  session?: ActorSession;
  externalId?: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  tool_use_id?: string;
  responseIdentity?: ResponseAuthorship;
  uploadsChat?: string;
  includeNodes?: boolean;
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

export interface ObservationFailedDetail {
  documentId: string;
  cause: unknown;
}
