/** Branded agent-edit core types for live-vs-branch compile-time separation. */
import type { AgentEditCore, ResponseCommitSuccessResult } from "@meridian/agent-edit/integration";

type ResponseTransactionOptions = Parameters<AgentEditCore["commitResponse"]>[1] & {
  beforeTransactionCommit?(result: ResponseCommitSuccessResult): void | Promise<void>;
};

declare const liveAgentEditCoreBrand: unique symbol;
declare const threadPeerAgentEditCoreBrand: unique symbol;

export type LiveAgentEditCore = AgentEditCore & {
  readonly [liveAgentEditCoreBrand]: "live-agent-edit-core";
};

export type ThreadPeerAgentEditCore = Omit<AgentEditCore, "commitResponse"> & {
  commitResponse(
    responseId: string,
    options?: ResponseTransactionOptions,
  ): Promise<ResponseCommitSuccessResult>;
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
