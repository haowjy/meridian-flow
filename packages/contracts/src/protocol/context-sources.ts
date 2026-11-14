/**
 * A project's sources: the roots its tree list holds. The list names a node's source by id; this
 * query says which source is the manuscript, which is a Work's Scratch, and so on. It is also how
 * a browser learns that a source ended or that its account lost access to one: neither is a tree
 * record.
 */
import type { CanonicalContextAuthority } from "../context-uri.js";
import type { ContextSourceId, WorkId } from "../ids.js";
import type { ProjectContextTreeScheme } from "./http-types.js";

/** Whose a source is. */
export type ContextSourceOwner =
  | { kind: "project" }
  | { kind: "work"; workId: WorkId }
  | { kind: "lineage"; rootThreadId: string }
  | { kind: "chat"; chatId: string };

export type ContextSource = {
  id: ContextSourceId;
  scheme: ProjectContextTreeScheme;
  name: string;
  owner: ContextSourceOwner;
  /** What the source's addresses are qualified with (a Work's handle, a chat's or lineage's ref), for `canonicalContextUri(scheme, path, authority)`. */
  authority: CanonicalContextAuthority;
};

/** The sources the account can read in one project, or the account's own (`user://`). */
export type ContextSourcesResult = {
  sources: readonly ContextSource[];
  /**
   * Sources that ended and can come back (a deleted Work's, a deleted chat's): readers drop them,
   * and a browser keeps its copies of their documents. A source named by neither list was purged
   * for good.
   */
  ended: readonly ContextSourceId[];
};

/**
 * A project's sources changed (one began, ended, was renamed, or the account lost or gained access
 * to it). Truth-free: it rides the project's existing subscription and says only "ask again".
 */
export type ContextSourcesHint = { type: "context-sources-hint"; projectId: string };
