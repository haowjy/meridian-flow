/** Branded agent-edit core types and the destination that routes each model call. */
import type {
  AgentEditCore,
  ReadCommand,
  ResponseCommitSuccessResult,
  WriteCommand,
  WriteContext,
  WriteOutcome,
} from "@meridian/agent-edit/integration";
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";

/**
 * Where a model call reads or writes one document, computed by the caller
 * from the file policy (D20): the live document, or this thread's copy of a
 * Work draft. The Work is part of the version, so `work switch` changes it
 * (D41). The slug only names the Work in model-facing copy.
 */
export type AgentEditDestination =
  | { kind: "live" }
  | { kind: "draft"; workId: WorkId; workSlug: string | null };

/** A core call's context with the destination the caller computed. */
export type RoutedWriteContext = WriteContext & { destination: AgentEditDestination };

/** Why the save step left a document out of a reply (D29). */
export type RefusedResponseDocument = {
  documentId: DocumentId;
  reason: "work_archived";
  workSlug: string | null;
};

/** One reply's save across every destination it wrote (D42). */
export type ResponseSaveResult = ResponseCommitSuccessResult & {
  /** Documents saved to this thread's Work draft copy; the rest went live. */
  draftedDocumentIds: DocumentId[];
  refused: RefusedResponseDocument[];
};

type ResponseTransactionOptions = Parameters<AgentEditCore["commitResponse"]>[1] & {
  beforeTransactionCommit?(result: ResponseSaveResult): void | Promise<void>;
};

declare const liveAgentEditCoreBrand: unique symbol;
declare const threadPeerAgentEditCoreBrand: unique symbol;

export type LiveAgentEditCore = AgentEditCore & {
  readonly [liveAgentEditCoreBrand]: "live-agent-edit-core";
};

export type ThreadPeerAgentEditCore = Omit<AgentEditCore, "read" | "write" | "commitResponse"> & {
  read(command: ReadCommand, context: RoutedWriteContext): Promise<WriteOutcome>;
  write(command: WriteCommand, context: RoutedWriteContext): Promise<WriteOutcome>;
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

export function sameDestination(left: AgentEditDestination, right: AgentEditDestination): boolean {
  if (left.kind === "live" || right.kind === "live") return left.kind === right.kind;
  return left.workId === right.workId;
}
