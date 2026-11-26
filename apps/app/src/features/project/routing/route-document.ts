import { canonicalDocumentPath } from "./local-document-address";
import type { ProjectDestination } from "./project-address";

type DocumentDestination = Extract<ProjectDestination, { kind: "document" }>;

export const ROUTE_DOCUMENT_STATE = "meridianRouteDocument";

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

export function rememberedRouteDocument(state: object, place: string | null): string | null {
  const held = (state as { [ROUTE_DOCUMENT_STATE]?: Remembered })[ROUTE_DOCUMENT_STATE];
  return place !== null && held?.place === place ? held.documentId : null;
}

export function routeDocumentMark(place: string, documentId: string): Record<string, unknown> {
  return { [ROUTE_DOCUMENT_STATE]: { place, documentId } satisfies Remembered };
}
