/** Branded agent-edit core types and the grant that authorizes and routes each model call. */
import type {
  AgentEditCore,
  ReadCommand,
  ResponseCommitSuccessResult,
  WriteCommand,
  WriteContext,
  WriteOutcome,
} from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
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
export type RefusedResponseDocument = {
  documentId: DocumentId;
  /** The policy's refusal under the save's locks; its copy is the tool's to write. */
  denial: FileAccessDenied;
};

/**
 * A model call's outcome. An undo or redo that reversed some of its writes but
 * was refused for others names the refused ones; the tool writes the copy.
 */
export type RoutedWriteOutcome = WriteOutcome & {
  refusedWrites?: { writeIds: string[]; denial: FileAccessDenied }[];
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
  read(command: ReadCommand, context: RoutedReadContext): Promise<WriteOutcome>;
  write(command: WriteCommand, context: RoutedWriteContext): Promise<RoutedWriteOutcome>;
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
