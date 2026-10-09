/**
 * Per-operation document-link scope: how stored links and image sources are
 * spelled, read from the document tree for each operation and never kept.
 *
 * Serialization is synchronous, so an operation opens a snapshot (`within`),
 * loads what its next synchronous block names in one batch (`prepare`), and
 * then spells through a holder-bound scope (`holder`). The snapshot is the only
 * ambient thing (compared serializations must spell from one snapshot, and the
 * codec sits deep inside engines that only know a document id); the holder,
 * its view and the reader are always explicit.
 *
 * Moves, deletes and other processes change the tree underneath any copy, so a
 * snapshot answers for the operation that opened it and nested doors join it;
 * work that only inherited a settled snapshot, such as a timer, opens its own.
 */
import type { HolderLinkScope } from "@meridian/agent-edit/integration";
import type { LinkView } from "@meridian/contracts";
import type { PMNode } from "@meridian/markup";
import type * as Y from "yjs";

export type { HolderLinkScope };

/** The project, named directly or by a document or thread in it, and whose file policy answers. */
export type LinkScopeKey = (
  | { projectId: string }
  | { documentId: string }
  | { threadId: string }
) & {
  /**
   * File-policy principal whose readability the snapshot answers (default: the
   * project owner), and the thread it acts in, whose reply's staged creates a
   * draft view counts.
   */
  viewer?: { accountId: string; threadId?: string };
  /** Documents the caller already knows share this project (e.g. one source's search). */
  documentIds?: readonly string[];
};

export interface ScopePrepareRequest {
  holders: readonly { documentId: string; view: LinkView }[];
  refs?: readonly string[];
  addresses?: readonly string[];
  /** Refs, asset ids and ahead addresses are extracted from these (stored-link extraction). */
  docs?: readonly Y.Doc[];
  /** Already-bound nodes about to be applied: extracted like `docs`. */
  nodes?: readonly PMNode[];
  /**
   * Freshly parsed nodes about to be bound: their written addresses resolve
   * against the first holder, so they load after it.
   */
  written?: readonly PMNode[];
  /** Views a `reader` will resolve in, beside the holders' (their draft membership loads too). */
  views?: readonly LinkView[];
}

export interface DocumentLinkScopes {
  /** Open or join a snapshot for one project and viewer. Nothing is loaded yet. */
  within<T>(key: LinkScopeKey, operation: () => Promise<T>): Promise<T>;
  /** Batched load into the innermost open snapshot. */
  prepare(request: ScopePrepareRequest): Promise<void>;
  /**
   * Synchronous holder-bound view of the innermost snapshot. It keeps that
   * snapshot, so work the operation defers past its end still spells from it.
   */
  holder(input: { documentId: string; view: LinkView }): HolderLinkScope;
  /**
   * The same, for a door with an address but no holder document (the resolver endpoint, chat:
   * `uri` null). Resolution never reads the holder; only spelling would.
   */
  reader(input: { uri: string | null; view: LinkView }): HolderLinkScope;
}

export const LIVE_VIEW: LinkView = { kind: "live" };

/** Durable ahead-ref registration (context's `LinkAheadRegistry.register`). */
export interface AheadRefRegistrar {
  register(
    registrations: readonly { aheadId: string; holderProjectId: string; address: string }[],
  ): Promise<void>;
}
