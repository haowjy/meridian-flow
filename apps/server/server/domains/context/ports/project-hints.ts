import type {
  AgentFilesHint,
  ContextSourcesHint,
  DraftHint,
  McpConnectionsHint,
  ProjectChatsHint,
} from "@meridian/contracts/protocol";

export type ProjectHint =
  | DraftHint
  | ProjectChatsHint
  | ContextSourcesHint
  | AgentFilesHint
  | McpConnectionsHint;

export interface ProjectWakePort {
  publish(hint: ProjectHint): void | Promise<void>;
}

/** Wakes the project's clients once the caller's transaction commits. */
export interface ProjectHintPort {
  publishDraftHints(hints: readonly DraftHint[]): void;
  /** A source of the project began, ended or was renamed, or access to it changed. */
  publishSourcesHint(projectId: string): void;
}
