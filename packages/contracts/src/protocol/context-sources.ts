import type { CanonicalContextAuthority } from "../context-uri.js";
import type { ContextSourceId, WorkId } from "../ids.js";
import type { ProjectContextTreeScheme } from "./http-types.js";

export type ContextSourceOwner =
  | { kind: "project" }
  | { kind: "account" }
  | { kind: "work"; workId: WorkId }
  | { kind: "lineage"; rootThreadId: string }
  | { kind: "chat"; chatId: string };

export type ContextSource = {
  id: ContextSourceId;
  scheme: ProjectContextTreeScheme;
  owner: ContextSourceOwner;
  authority: CanonicalContextAuthority;
};

export type ContextSourcesResult = {
  sources: readonly ContextSource[];
  ended: readonly ContextSourceId[];
};

export type ContextSourcesHint = { type: "context-sources-hint"; projectId: string };
