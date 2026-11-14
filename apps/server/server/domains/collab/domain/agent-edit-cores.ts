/** Branded agent-edit core types and the grant that authorizes and routes each model call. */
import type { AgentEditCore, WriteContext, WriteOutcome } from "@meridian/agent-edit/integration";
import { draftOwnerKey } from "@meridian/contracts";
import type { FileAccessDenied, FileDestination, FileGrant } from "../../file-policy/index.js";

/**
 * A write's context: the edit grant the caller got from the file policy. Its
 * destination routes the call, and the write seams confirm it (file-access §5).
 */
export type RoutedWriteContext = WriteContext & { grant: FileGrant<"edit"> };

/**
 * A read's context. `liveVersion` marks a `version: "live"` read: it reads the live document
 * even when the thread has a Work draft of it, where a default read follows the grant's
 * destination.
 */
export type RoutedReadContext = WriteContext & { grant: FileGrant; liveVersion?: boolean };

/** An inverse may reverse some writes and name the policy refusals for the rest. */
export type RoutedWriteOutcome = WriteOutcome & {
  refusedWrites?: { writeIds: string[]; denial: FileAccessDenied }[];
};

declare const liveAgentEditCoreBrand: unique symbol;

export type LiveAgentEditCore = AgentEditCore & {
  readonly [liveAgentEditCoreBrand]: "live-agent-edit-core";
};

export function asLiveAgentEditCore(core: AgentEditCore): LiveAgentEditCore {
  return core as LiveAgentEditCore;
}

export function sameDestination(left: FileDestination, right: FileDestination): boolean {
  if (left.kind === "live" || right.kind === "live") return left.kind === right.kind;
  return draftOwnerKey(left.owner) === draftOwnerKey(right.owner);
}
