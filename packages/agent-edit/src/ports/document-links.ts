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
  written?: readonly PMNode[];
  stored?: readonly PMNode[];
  refs?: readonly string[];
  addresses?: readonly string[];
  shown?: readonly ShownLink[];
  context?: WriteContext;
}

export interface AheadMint {
  ref: AheadRef;
  address: string;
  holderProjectId: string;
  view: LinkView;
}

export interface DocumentLinksPort {
  /** One batched load; awaited before every synchronous render, assign or apply block. */
  prepare(request: LinkPrepareRequest): Promise<void>;
  scopeFor(documentId: string, context: WriteContext | undefined): HolderLinkScope;
  /** Independent durable registration (§6). Throws if called inside a DB transaction. */
  registerAhead(mints: readonly AheadMint[]): Promise<void>;
  /**
   * View revision (§8), synchronous with the render or apply it identifies: it names a cut by its
   * room version and the blocks it shows.
   */
  revision(cut: DocumentCut, scope: HolderLinkScope): string;
}
