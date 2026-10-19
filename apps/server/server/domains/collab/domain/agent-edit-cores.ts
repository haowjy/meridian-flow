/** Branded agent-edit core types and the grant that authorizes and routes each model call. */
import type {
  AgentEditCore,
  FrontierLookup,
  ReadCommand,
  ResponseCommitSuccessResult,
  RetiredWriteReason,
  StagedWriteRejectionReason,
  WriteCommand,
  WriteContext,
  WriteOutcome,
} from "@meridian/agent-edit/integration";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { FileAccessDenied, FileDestination, FileGrant } from "../../file-policy/index.js";

/**
 * The read that names a live document's frontier room
 * (`live:<documentId>:<authorityGeneration>`). Answers null when the document
 * has no live room yet or it can't be read: the call then records no frontier.
 * M1 scaffolding: M2 renders from the room doc, whose authority identity is
 * already bound to it.
 */
export type FrontierRooms = {
  /** A live document's authority generation (the version-restore epoch). */
  liveGeneration(documentId: DocumentId): Promise<bigint | null>;
};

/**
 * A call that records what it showed passes the lookup its frontier chains
 * from (rooms `draft:<workDraftId>` or `live:<documentId>:<authorityGeneration>`);
 * its outcome then carries `frontier`.
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

/** Why the save step left a document out of a reply (D29). */
export type RefusedResponseDocument =
  | {
      documentId: DocumentId;
      /** The policy's permission refusal under the save's locks; its copy is the tool's to write. */
      denial: FileAccessDenied;
    }
  | {
      documentId: DocumentId;
      /**
       * The document is not found, or its draft closed because it was removed: the writes are
       * dropped with the record's copy. Null when there is no record: the document went with
       * its source or Work, or stands again.
       */
      removed: DocumentRemovalRecord | null;
    }
  | {
      documentId: DocumentId;
      /**
       * The branch its writes were pinned to moved on before the save (closed, or this
       * document's draft applied or discarded): the save never retargets them to a new branch (§2.5).
       */
      reason: StagedWriteRejectionReason;
    };

/** One reply's save across every destination it wrote (D42). */
export type ResponseSaveResult = ResponseCommitSuccessResult & {
  refused: RefusedResponseDocument[];
};

type ResponseTransactionOptions = Omit<
  NonNullable<Parameters<AgentEditCore["commitResponse"]>[1]>,
  "observe"
> & {
  beforeTransactionCommit?(result: ResponseSaveResult): void | Promise<void>;
  /**
   * Record each saved document's frontier at the post-commit cut, chained from
   * the model's latest frontier for its room (this lookup).
   */
  recordingFrontier?: FrontierLookup;
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
  read(command: ReadCommand, context: RoutedReadContext): Promise<WriteOutcome>;
  write(command: WriteCommand, context: RoutedWriteContext): Promise<WriteOutcome>;
  /**
   * Retire exactly these peers on `documentId` after their drafts closed or were deleted:
   * their staged writes are refused with the reason, then their runtimes and pulled baselines
   * go. Durable draft rows are the caller's; other threads and documents are untouched.
   */
  retireThreadPeers(
    documentId: string,
    peers: readonly { threadId: string; peerDraftId: string; reason: RetiredWriteReason }[],
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
