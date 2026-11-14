/**
 * The route's continuity: the last document id its address resolved. While the address stays the
 * place that document was last resolved at, the route is that document wherever the replay now
 * puts it (a rename or a move), and a reused path is not it. Pointing the route elsewhere is just
 * a different address: it has no remembered id until it resolves one.
 */

import { useCallback, useState } from "react";
import { canonicalDocumentPath } from "./local-document-address";
import type { ProjectDestination } from "./project-address";

type DocumentDestination = Extract<ProjectDestination, { kind: "document" }>;

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

export type RouteDocument = {
  /** The document the address at `place` last resolved to, if it is still at that place. */
  documentId: string | null;
  remember(place: string, documentId: string): void;
  /** The remembered document is nowhere the replay can show it: the address decides again. */
  forget(): void;
};

export function useRouteDocument(place: string | null): RouteDocument {
  const [memory, setMemory] = useState<{ place: string; documentId: string } | null>(null);
  const remember = useCallback(
    (at: string, documentId: string) =>
      setMemory((held) =>
        held?.place === at && held.documentId === documentId ? held : { place: at, documentId },
      ),
    [],
  );
  const forget = useCallback(() => setMemory(null), []);
  return {
    documentId: place !== null && memory?.place === place ? memory.documentId : null,
    remember,
    forget,
  };
}
