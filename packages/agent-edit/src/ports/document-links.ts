/**
 * Host port for link and image-source spelling and ref assignment (contract §4.3).
 *
 * The host owns the document tree. Before every synchronous render, assign or
 * apply block, agent-edit awaits `prepare` with everything that block may
 * spell or assign; `scopeFor` then answers synchronously for one holder in one
 * view. The scope is markup's `createHolderLinkScope` over the host's catalog,
 * so every host applies the same rules.
 */
import type { AheadRef, LinkView } from "@meridian/contracts";
import type { PMNode } from "@meridian/markup";
import type { HolderLinkScope } from "@meridian/markup/links";
import type { ShownLink } from "../links/correspondence.js";
import type { WriteContext } from "../tool/types.js";
import type { DocumentCut } from "./document-rooms.js";

export interface LinkPrepareRequest {
  documentId: string;
  /** Freshly parsed nodes whose written addresses ref assignment may resolve. */
  written?: readonly PMNode[];
  /** Copied nodes: they already carry stored attrs and are spelled as stored. */
  stored?: readonly PMNode[];
  /** Refs no doc carries yet that will be spelled (ahead refs this write registered). */
  refs?: readonly string[];
  /** Decoded addresses to load (a registered ahead ref's own address). */
  addresses?: readonly string[];
  shown?: readonly ShownLink[];
  context?: WriteContext;
}

export interface AheadMint {
  ref: AheadRef;
  /** aheadAddress(...) result: decoded, canonical, with an extension. */
  address: string;
  /** The holder scope's project at mint time: the registry's namespace. */
  holderProjectId: string;
  /** The holder scope's view at mint time: a draft view registers the ref's meaning there too. */
  view: LinkView;
}

export interface DocumentLinksPort {
  /** One batched load; awaited before every synchronous render, assign or apply block. */
  prepare(request: LinkPrepareRequest): Promise<void>;
  /** Synchronous; holder and view come from the arguments, the snapshot from the open scope. */
  scopeFor(documentId: string, context: WriteContext | undefined): HolderLinkScope;
  /** Independent durable registration (§6). Throws if called inside a DB transaction. */
  registerAhead(mints: readonly AheadMint[]): Promise<void>;
  /**
   * View revision (§8), synchronous with the render or apply it identifies: it names a cut by its
   * room version and the blocks it shows.
   */
  revision(cut: DocumentCut, scope: HolderLinkScope): string;
}
