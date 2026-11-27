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
