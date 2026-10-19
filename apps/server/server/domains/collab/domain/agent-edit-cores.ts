/** Routed agent-edit cores, their grants, and immutable revert source materialization. */
import type {
  AgentEditCore,
  ReadCommand,
  ResponseCommitSuccessResult,
  RetiredWriteReason,
  StagedWriteRejectionReason,
  WriteCommand,
  WriteContext,
  WriteOutcome,
} from "@meridian/agent-edit/integration";
import {
  containsSnapshot,
  type DocumentCoordinator,
  decodeSnapshot,
  type RevertSource,
} from "@meridian/agent-edit/integration";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import type { FileAccessDenied, FileDestination, FileGrant } from "../../file-policy/index.js";

/**
 * A write's context: the edit grant the caller got from the file policy. Its
 * destination routes the call, and the write seams confirm it (file-access §5).
 */
export type RoutedWriteContext = WriteContext & { grant: FileGrant<"edit"> };

/**
 * A read's context. `liveVersion` marks a `version: "live"` read (D3): it reads
 * the live document even when this reply already drafted it, where a default
 * read follows the reply's pinned destination.
 */
export type RoutedReadContext = WriteContext & { grant: FileGrant; liveVersion?: boolean };

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

/** An inverse may reverse some writes and name the policy refusals for the rest. */
export type RoutedWriteOutcome = WriteOutcome & {
  refusedWrites?: { writeIds: string[]; denial: FileAccessDenied }[];
};

/** One reply's save across every destination it wrote (D42). */
export type ResponseSaveResult = ResponseCommitSuccessResult & {
  refused: RefusedResponseDocument[];
};

type ResponseTransactionOptions = NonNullable<Parameters<AgentEditCore["commitResponse"]>[1]> & {
  beforeTransactionCommit?(result: ResponseSaveResult): void | Promise<void>;
};

declare const liveAgentEditCoreBrand: unique symbol;
declare const threadPeerAgentEditCoreBrand: unique symbol;

export type LiveAgentEditCore = AgentEditCore & {
  readonly [liveAgentEditCoreBrand]: "live-agent-edit-core";
};

// A reply's created set isn't asked of the pool: a create is a row in the tree view.
export type ThreadPeerAgentEditCore = Omit<
  AgentEditCore,
  "read" | "write" | "commitResponse" | "prepareResponse" | "responseDocuments" | "readRoom"
> & {
  read(command: ReadCommand, context: RoutedReadContext): Promise<WriteOutcome>;
  /**
   * The room copy a call on this document would read: the reply's pinned destination with its
   * surviving staged writes, the thread's Work draft, or live. The caller disposes it.
   */
  readRoom(input: {
    documentId: DocumentId;
    threadId?: ThreadId | null;
    responseId?: string | null;
    live: boolean;
  }): Promise<{ doc: Y.Doc; room: string | null; dispose(): void }>;
  write(command: WriteCommand, context: RoutedWriteContext): Promise<RoutedWriteOutcome>;
  /**
   * Retire exactly these peers on `documentId` after their drafts closed or were deleted:
   * their staged writes are refused with the reason. Durable draft rows are the caller's;
   * other threads and documents are untouched.
   */
  retireThreadPeers(
    documentId: string,
    peers: readonly { threadId: string; peerDraftId: string; reason: RetiredWriteReason }[],
  ): Promise<void>;
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

/** Immutable receipt and source-history reads; neither grants a destination write. */
export function createRevertSourceResolver(reads: {
  receipt(
    threadId: string,
    documentId: string,
    wId: number,
  ): Promise<{
    room: string | null;
    before: Uint8Array | null;
    after: Uint8Array | null;
    effect: Extract<RevertSource, { a: Y.Doc }>["effect"];
  } | null>;
  source(
    room: string,
    documentId: string,
  ): Promise<{ doc: Y.Doc } | Extract<RevertSource, { refusal: string }>>;
}): DocumentCoordinator["resolveRevertSource"] {
  return async ({ threadId, documentId, edit, destination }) => {
    if (!/^w[1-9]\d*$/.test(edit) || !Number.isSafeInteger(Number(edit.slice(1))))
      return { refusal: "invalid_write" };
    const receipt = await reads.receipt(threadId, documentId, Number(edit.slice(1)));
    if (!receipt) return { refusal: "invalid_write" };
    if (!receipt.room || !receipt.before || !receipt.after) return { refusal: "no_cuts" };
    const sameRoom = receipt.room === destination.room;
    const source = sameRoom
      ? { doc: destination.doc }
      : await reads.source(receipt.room, documentId);
    if ("refusal" in source) return source;
    let a: Y.Doc | undefined;
    let b: Y.Doc | undefined;
    try {
      const before = decodeSnapshot(receipt.before),
        after = decodeSnapshot(receipt.after);
      const current = Y.snapshot(source.doc);
      if (
        !before ||
        !after ||
        !containsSnapshot(current, before) ||
        !containsSnapshot(current, after)
      )
        return {
          refusal: "cut_not_contained",
          reason: receipt.room.startsWith("draft:")
            ? "draft_reset_or_discarded"
            : "live_generation_changed",
        };
      a = new Y.Doc({ gc: false });
      b = new Y.Doc({ gc: false });
      Y.createDocFromSnapshot(source.doc, after, a);
      Y.createDocFromSnapshot(source.doc, before, b);
      return { a, b, effect: receipt.effect };
    } catch (cause) {
      a?.destroy();
      b?.destroy();
      throw cause;
    } finally {
      if (!sameRoom) source.doc.destroy();
    }
  };
}
