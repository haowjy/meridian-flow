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
  registerAhead(mints: readonly AheadMint[]): Promise<void>;
  revision(cut: DocumentCut, scope: HolderLinkScope): string;
}
