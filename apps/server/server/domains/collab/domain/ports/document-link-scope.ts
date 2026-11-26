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
import type { CatalogDocument, LinkView } from "@meridian/contracts";
import type { PMNode } from "@meridian/markup";
import type { HolderLinkScope } from "@meridian/markup/links";

export type { HolderLinkScope };

export type LinkScopeKey = (
  | { projectId: string }
  | { documentId: string }
  | { threadId: string }
) & {
  viewer?: { accountId?: string; threadId?: string };
  memberships?: readonly { view: LinkView; members: readonly string[] }[];
  documentIds?: readonly string[];
};

export interface ScopePrepareRequest {
  holders: readonly { documentId: string; view: LinkView }[];
  refs?: readonly string[];
  addresses?: readonly string[];
  folderAddresses?: readonly string[];
  stored?: readonly PMNode[];
  written?: readonly PMNode[];
  uploadsChat?: string;
  views?: readonly LinkView[];
}

export interface DocumentLinkScopes {
  within<T>(key: LinkScopeKey, operation: () => Promise<T>): Promise<T>;
  prepare(request: ScopePrepareRequest): Promise<void>;
  holder(input: { documentId: string; view: LinkView }): HolderLinkScope;
  reader(input: { uri: string | null; view: LinkView }): HolderLinkScope;
  draftCreatedAt(input: { view: LinkView; uri: string }): CatalogDocument | null;
  pinHolder(input: {
    view: LinkView;
    documentId?: string;
    uri: string | null;
  }): Promise<{ documentId: string; uri: string } | null>;
}

export const LIVE_VIEW: LinkView = { kind: "live" };

export interface AheadRefRegistrar {
  /**
   * `register` for a write already inside its command transaction: it takes the targets'
   * namespace keys on that transaction's connection, never a second one.
   */
  registerInCommand(
    registrations: readonly {
      aheadId: string;
      holderProjectId: string;
      address: string;
    }[],
  ): Promise<void>;
  register(
    registrations: readonly {
      aheadId: string;
      holderProjectId: string;
      address: string;
    }[],
  ): Promise<void>;
}
