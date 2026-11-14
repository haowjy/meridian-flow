/**
 * The route's continuity: the last document id an address resolved, kept on the history entry
 * that address belongs to (as `meridianProjectSelection` is), so Back, Forward and a reload each
 * find the document that entry showed. While the entry's address is still the place that
 * document was resolved at, the route is that document wherever the replay now puts it (a rename
 * or a move), and a reused path is not it. An entry that never resolved one has none.
 */

import { canonicalDocumentPath } from "./local-document-address";
import type { ProjectDestination } from "./project-address";

type DocumentDestination = Extract<ProjectDestination, { kind: "document" }>;

export const ROUTE_DOCUMENT_STATE = "meridianRouteDocument";

/** Where an address points: its scheme, path and, for Scratch, its owner. */
export function routePlaceKey(
  destination: DocumentDestination | null,
  owner: { workId?: string; rootThreadId?: string },
): string | null {
  return destination
    ? [
        destination.scheme,
        canonicalDocumentPath(destination.path),
        owner.workId ?? "",
        owner.rootThreadId ?? "",
      ].join("\u0000")
    : null;
}

type Remembered = { place: string; documentId: string };

/** The document the entry's address last resolved to, if the entry is still at that place. */
export function rememberedRouteDocument(state: object, place: string | null): string | null {
  const held = (state as { [ROUTE_DOCUMENT_STATE]?: Remembered })[ROUTE_DOCUMENT_STATE];
  return place !== null && held?.place === place ? held.documentId : null;
}

/** The history-state mark that remembers the entry's document. */
export function routeDocumentMark(place: string, documentId: string): Record<string, unknown> {
  return { [ROUTE_DOCUMENT_STATE]: { place, documentId } satisfies Remembered };
}
