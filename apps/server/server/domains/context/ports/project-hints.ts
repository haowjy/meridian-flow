/** What a project's subscribers are woken with. Every hint is lossy and truth-free: it says "ask again". */
import type {
  AgentFilesHint,
  ContextSourcesHint,
  DraftOwnerHint,
  McpConnectionsHint,
  ProjectChatsHint,
} from "@meridian/contracts/protocol";

export type ProjectHint =
  | DraftOwnerHint
  | ProjectChatsHint
  | ContextSourcesHint
  | AgentFilesHint
  | McpConnectionsHint;

export interface ProjectWakePort {
  publish(hint: ProjectHint): void | Promise<void>;
}

/** Wakes the project's clients once the caller's transaction commits. */
export interface ProjectHintPort {
  publishDraftOwnerHints(hints: readonly DraftOwnerHint[]): void;
  /** A source of the project began, ended or was renamed, or access to it changed. */
  publishSourcesHint(projectId: string): void;
}
