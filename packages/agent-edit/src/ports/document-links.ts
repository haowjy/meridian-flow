/**
 * Host port for link and image-source spelling and ref assignment (contract §4.3).
 *
 * The host owns the document tree. Before every synchronous render, assign or
 * apply block, agent-edit awaits `prepare` with everything that block may
 * spell or assign; `scopeFor` then answers synchronously for one holder in one
 * view. The scope is markup's `createHolderLinkScope` over the host's catalog,
 * so every host applies the same rules.
 */
import type { AheadRef } from "@meridian/contracts";
import type { HolderLinkScope, PMNode } from "@meridian/markup";
import type * as Y from "yjs";
import type { ShownLink } from "../links/correspondence.js";
import type { WriteContext } from "../tool/types.js";

export interface LinkPrepareRequest {
  documentId: string;
  /** Docs the next synchronous block serializes or assigns against (old runtime, overlays). */
  docs: readonly Y.Doc[];
  /** Freshly parsed nodes whose written addresses ref assignment may resolve. */
  written?: readonly PMNode[];
  /**
   * Nodes that already carry stored attrs and will be spelled as stored:
   * copies, and a host's bound write (`WriteContext.boundNodes`).
   */
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
}

export interface DocumentLinksPort {
  /** One batched load; awaited before every synchronous render, assign or apply block. */
  prepare(request: LinkPrepareRequest): Promise<void>;
  /** Synchronous; holder and view come from the arguments, the snapshot from the open scope. */
  scopeFor(documentId: string, context: WriteContext | undefined): HolderLinkScope;
  /** Independent durable registration (§6). Throws if called inside a DB transaction. */
  registerAhead(mints: readonly AheadMint[]): Promise<void>;
  /** View revision (§8), synchronous with the render or apply it identifies. */
  revision(doc: Y.Doc, scope: HolderLinkScope): string;
}
