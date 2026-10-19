/** Branded agent-edit core types and the grant that authorizes and routes each model call. */
import type {
  AgentEditCore,
  DiscardedWriteReason,
  ObservationFrontier,
  ReadCommand,
  ResponseCommitSuccessResult,
  StagedWriteRejectionReason,
  WriteCommand,
  WriteContext,
  WriteOutcome,
} from "@meridian/agent-edit/integration";
import type { BranchId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { FileAccessDenied, FileDestination, FileGrant } from "../../file-policy/index.js";

/**
 * The model's latest observation frontier for a room (`draft:<workDraftId>` or
 * `live:<documentId>:<authorityGeneration>`), from the caller's transcript.
 * Never throws: an unavailable frontier is `null`, the empty one.
 */
export type FrontierLookup = (roomKey: string) => Promise<ObservationFrontier | null>;

/**
 * The reads that name a frontier's room. Each answers null when there is no
 * such room yet or it can't be read: the call then records no frontier.
 */
export type FrontierRooms = {
  /** A live document's authority generation (the version-restore epoch). */
  liveGeneration(documentId: DocumentId): Promise<bigint | null>;
  /** The branch's active Work draft on the document; never makes one. */
  workDraftId(documentId: DocumentId, branchId: BranchId): Promise<string | null>;
};

/** A frontier the pool observed, keyed by the room it was rendered from. */
export type RoomObservation = ObservationFrontier & { roomKey: string };

/**
 * A call that records what it showed passes the lookup its frontier chains
 * from; its outcome then carries `frontiers`.
 */
type ObservedCall = { recordingFrontier?: FrontierLookup };

/**
 * A write's context: the edit grant the caller got from the file policy. Its
 * destination routes the call, and the write seams confirm it (file-access §5).
 */
export type RoutedWriteContext = WriteContext & ObservedCall & { grant: FileGrant<"edit"> };

/**
 * A read's context. `liveVersion` marks a `version: "live"` read (D3): it reads
 * the live document even when this reply already drafted it, where a default
 * read follows the reply's pinned destination.
 */
export type RoutedReadContext = WriteContext &
  ObservedCall & { grant: FileGrant; liveVersion?: boolean };

/**
 * A routed call's outcome. Host-only `frontiers` replace agent-edit's
 * room-less `observation`, which the pool never forwards.
 */
export type RoutedOutcome = WriteOutcome & { frontiers?: RoomObservation[] };

/** Why the save step left a document out of a reply (D29). */
export type RefusedResponseDocument =
  | {
      documentId: DocumentId;
      /** The policy's refusal under the save's locks; its copy is the tool's to write. */
      denial: FileAccessDenied;
    }
  | {
      documentId: DocumentId;
      /**
       * The branch its writes were pinned to moved on before the save (closed, or this
       * document's draft applied or discarded): the save never retargets them to a new branch (§2.5).
       */
      reason: StagedWriteRejectionReason;
    };

/**
 * A model call's outcome. An undo or redo that reversed some of its writes but
 * was refused for others names the refused ones; the tool writes the copy.
 */
export type RoutedWriteOutcome = RoutedOutcome & {
  refusedWrites?: { writeIds: string[]; denial: FileAccessDenied }[];
};

/**
 * A saved document. When the save recorded frontiers, `room` names the room it
 * committed to and its frontier at the post-commit cut, null when that could
 * not be computed; it replaces agent-edit's room-less `observation`.
 */
export type ResponseSaveDocument = Omit<
  ResponseCommitSuccessResult["documents"][number],
  "observation"
> & {
  room?: { roomKey: string; frontier: ObservationFrontier | null };
};

/** One reply's save across every destination it wrote (D42). */
export type ResponseSaveResult = Omit<ResponseCommitSuccessResult, "documents"> & {
  documents: ResponseSaveDocument[];
  refused: RefusedResponseDocument[];
};

type ResponseTransactionOptions = Omit<
  NonNullable<Parameters<AgentEditCore["commitResponse"]>[1]>,
  "observe"
> & {
  beforeTransactionCommit?(result: ResponseSaveResult): void | Promise<void>;
  /**
   * Record each saved document's frontier at the post-commit cut, chained from
   * the frontier the reply's step was planned on (this lookup).
   */
  planningFrontier?: FrontierLookup;
};

declare const liveAgentEditCoreBrand: unique symbol;
declare const threadPeerAgentEditCoreBrand: unique symbol;

export type LiveAgentEditCore = AgentEditCore & {
  readonly [liveAgentEditCoreBrand]: "live-agent-edit-core";
};

// A reply's created set isn't asked of the pool: a create is a row in the tree view.
export type ThreadPeerAgentEditCore = Omit<
  AgentEditCore,
  "read" | "write" | "commitResponse" | "prepareResponse" | "responseDocuments"
> & {
  read(command: ReadCommand, context: RoutedReadContext): Promise<RoutedOutcome>;
  write(command: WriteCommand, context: RoutedWriteContext): Promise<RoutedWriteOutcome>;
  /**
   * Retire exactly these peers on `documentId` after their drafts closed or were deleted:
   * their staged writes are refused with the reason, then their runtimes and pulled baselines
   * go. Durable draft rows are the caller's; other threads and documents are untouched.
   */
  retireThreadPeers(
    documentId: string,
    peers: readonly { threadId: string; peerDraftId: string; reason: DiscardedWriteReason }[],
  ): Promise<void>;
  /** Where this reply's writes to a document go, once it has written there. */
  responseDestination(responseId: string, documentId: string): FileDestination | undefined;
  commitResponse(
    responseId: string,
    options?: ResponseTransactionOptions,
  ): Promise<ResponseSaveResult>;
  readonly [threadPeerAgentEditCoreBrand]: "thread-peer-agent-edit-core";
};

export function asLiveAgentEditCore(core: AgentEditCore): LiveAgentEditCore {
  return core as LiveAgentEditCore;
}

export function asThreadPeerAgentEditCore(
  core: Omit<ThreadPeerAgentEditCore, typeof threadPeerAgentEditCoreBrand>,
): ThreadPeerAgentEditCore {
  return core as ThreadPeerAgentEditCore;
}

export function sameDestination(left: FileDestination, right: FileDestination): boolean {
  if (left.kind === "live" || right.kind === "live") return left.kind === right.kind;
  return left.workId === right.workId;
}
