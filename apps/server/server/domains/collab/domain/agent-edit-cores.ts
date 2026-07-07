/** Branded agent-edit core types for live-vs-branch compile-time separation. */
import type { AgentEditCore } from "@meridian/agent-edit";

declare const liveAgentEditCoreBrand: unique symbol;
declare const threadPeerAgentEditCoreBrand: unique symbol;

export type LiveAgentEditCore = AgentEditCore & {
  readonly [liveAgentEditCoreBrand]: "live-agent-edit-core";
};

export type ThreadPeerAgentEditCore = AgentEditCore & {
  readonly [threadPeerAgentEditCoreBrand]: "thread-peer-agent-edit-core";
};

export function asLiveAgentEditCore(core: AgentEditCore): LiveAgentEditCore {
  return core as LiveAgentEditCore;
}

export function asThreadPeerAgentEditCore(core: AgentEditCore): ThreadPeerAgentEditCore {
  return core as ThreadPeerAgentEditCore;
}
