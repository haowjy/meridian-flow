/**
 * The session-bound half of an open document: one live room binding. Main's and the side's
 * documents both render through it, so a document has exactly one way to reach its
 * `DocumentSession` and no view owns a second copy of its Loro docs or room. The session paints from the
 * browser's local copy and connects to the room by itself; there is nothing to hand over when
 * the server learns of a document made here.
 */
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { DocumentSession } from "@/core/editor/document-session";
import type { DocumentPresentation } from "./document-presentation";
import type { LiveDocumentBindingState } from "./use-live-document-binding";
import { useLiveDocumentBinding } from "./use-live-document-binding";

type OpenDocumentSessionProps = {
  projectId: string;
  documentId: string;
  workOnly?: boolean;
  draftId?: string;
  held?: boolean;
  bindingOwner?: DocumentPresentation["bindingOwner"];
  children: (
    session: DocumentSession | null,
    failed: boolean,
    localContentReady: boolean,
    retry: () => void,
    failureReason: Extract<LiveDocumentBindingState, { kind: "failed" }>["reason"] | null,
  ) => ReactNode;
};

export function OpenDocumentSessionBoundary(props: OpenDocumentSessionProps) {
  const [opening, setOpening] = useState(0);
  const reopen = useCallback(() => setOpening((value) => value + 1), []);
  return <OpenDocumentSession key={opening} {...props} onReopen={reopen} />;
}

function OpenDocumentSession({
  projectId,
  documentId,
  workOnly = false,
  draftId,
  held = false,
  bindingOwner = "desktop-document-host",
  children,
  onReopen,
}: OpenDocumentSessionProps & { onReopen: () => void }) {
  const binding = useLiveDocumentBinding({
    projectId,
    documentId: held ? null : documentId,
    owner: bindingOwner,
    ...(workOnly ? { workOnly: true as const } : {}),
    ...(draftId ? { draftId } : {}),
  });
  const state = binding.state;
  // Until the binding catches up with a switch between Live and a draft, the old room is not shown.
  const room = state.kind === "opened" ? state.session.room : null;
  const opened =
    state.kind === "opened" &&
    state.documentId === documentId &&
    (room?.kind === "fork" ? room.draftId : undefined) === draftId
      ? state.session
      : null;
  const failed = state.kind === "failed" && state.documentId === documentId;
  const [localReady, setLocalReady] = useState<{ session: DocumentSession; ready: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (!opened) return;
    let active = true;
    void opened.hasInitializedLocalContent().then(
      (ready) => active && setLocalReady({ session: opened, ready }),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [opened]);
  const ready = localReady?.session === opened && localReady.ready;
  return children(opened, failed, ready, onReopen, failed ? state.reason : null);
}
