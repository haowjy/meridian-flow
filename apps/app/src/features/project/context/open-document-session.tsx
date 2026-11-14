/**
 * The session-bound half of an open document: one live room binding. Main's and the side's
 * documents both render through it, so a document has exactly one way to reach
 * its `DocumentSession` and no view owns a second Y.Doc, room or capture.
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { DocumentSession } from "@/core/editor/document-session";
import type { DocumentPresentation } from "./document-presentation";
import type { LiveDocumentBindingState } from "./use-live-document-binding";
import { useLiveDocumentBinding } from "./use-live-document-binding";
import { useRefusedEditsReopen } from "./use-refused-edits-reopen";

type OpenDocumentSessionProps = {
  projectId: string;
  documentId: string;
  availabilityRevision: string;
  /** False for a document with no live room yet (draft-only until Apply promotes it). */
  liveRoom?: boolean;
  bindingOwner?: DocumentPresentation["bindingOwner"];
  children: (
    session: DocumentSession | null,
    failed: boolean,
    localContentReady: boolean,
    retry: () => void,
    failureReason: Extract<LiveDocumentBindingState, { kind: "failed" }>["reason"] | null,
  ) => ReactNode;
};

/**
 * One stable host across local adoption; server retention lasts until the host
 * unmounts. A room dropped because the server refused its edits reopens as a
 * fresh session: local probe and server binding both start over.
 */
export function OpenDocumentSessionBoundary(props: OpenDocumentSessionProps) {
  const [opening, setOpening] = useState(0);
  const reopen = useCallback(() => setOpening((value) => value + 1), []);
  return <OpenDocumentSession key={opening} {...props} onReopen={reopen} />;
}

function OpenDocumentSession({
  projectId,
  documentId,
  availabilityRevision,
  liveRoom = true,
  bindingOwner = "desktop-document-host",
  children,
  onReopen,
}: OpenDocumentSessionProps & { onReopen: () => void }) {
  const binding = useLiveDocumentBinding({
    projectId,
    documentId: liveRoom ? documentId : null,
    owner: bindingOwner,
  });
  const automaticRetryRevision = useRef(availabilityRevision);
  useEffect(() => {
    if (binding.state.kind !== "failed" || automaticRetryRevision.current === availabilityRevision)
      return;
    automaticRetryRevision.current = availabilityRevision;
    binding.retry();
  }, [availabilityRevision, binding.retry, binding.state.kind]);
  const state = binding.state;
  // A document the writer just made is a node in the list before the server has admitted its
  // `create`: the server does not know it yet, so the open is asked again until it does.
  useEffect(() => {
    if (state.kind !== "failed" || state.documentId !== documentId) return;
    const timer = window.setTimeout(binding.retry, NOT_YET_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [binding.retry, documentId, state]);
  const liveSession =
    state.kind === "opened" && state.documentId === documentId ? state.session : null;
  const session = useRefusedEditsReopen(liveSession, onReopen);
  return children(
    session,
    state.kind === "failed" && state.documentId === documentId,
    false,
    onReopen,
    state.kind === "failed" && state.documentId === documentId ? state.reason : null,
  );
}

const NOT_YET_RETRY_MS = 2_000;
