/**
 * One concrete desktop/mobile host's ordinary live-document binding, with retry.
 *
 * A failed open, or a session the server closed the room on, is retried once when
 * the document's availability advances: a room can be refused before the document
 * is readable (a draft-only document reviewed ahead of Apply) and only the
 * availability change says "not yet" is now "available".
 */
import type { ResourceProjectionSnapshot } from "@meridian/resource-replica";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentSession } from "@/core/editor/document-session";
import { type LiveDocumentBinding, liveSessionDenied } from "./open-project-document";
import { useProjectDocumentLiveOpener } from "./project-document-live-opener-context";

export type LiveDocumentBindingState =
  | { kind: "absent" }
  | { kind: "opening"; documentId: string }
  | { kind: "opened"; documentId: string; generation: string; session: DocumentSession }
  | { kind: "failed"; documentId: string };

export type LiveDocumentHostBinding = {
  state: LiveDocumentBindingState;
  retry(): void;
};

let hostSequence = 0;

/** Changes when the resource replica learns something new about the document's availability. */
export function resourceAvailabilityRevision(
  snapshot: ResourceProjectionSnapshot | null,
  documentId: string,
): string {
  if (!snapshot) return "pending";
  const resource = snapshot.records.find(
    (record) => record.resource.identity.documentId === documentId,
  )?.resource;
  return JSON.stringify([
    resource?.revision ?? null,
    resource?.lifecycle.kind === "acknowledged"
      ? resource.lifecycle.availabilityGeneration
      : resource?.lifecycle.kind === "terminal"
        ? resource.lifecycle.generation
        : null,
  ]);
}

export function useLiveDocumentBinding({
  projectId,
  documentId,
  availabilityRevision,
  owner,
}: {
  projectId: string;
  documentId: string | null;
  availabilityRevision: string;
  owner: "desktop-server-tab" | "mobile-project-document-host";
}): LiveDocumentHostBinding {
  const opener = useProjectDocumentLiveOpener();
  const hostId = useRef(`${owner}:${++hostSequence}`);
  const attemptRef = useRef(0);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const attemptedRevision = useRef(availabilityRevision);
  const latestRevision = useRef(availabilityRevision);
  latestRevision.current = availabilityRevision;
  const [denied, setDenied] = useState(false);
  const [state, setState] = useState<LiveDocumentBindingState>(
    documentId ? { kind: "opening", documentId } : { kind: "absent" },
  );

  // retryGeneration is in the deps so retry() re-runs the open after a failure.
  useEffect(() => {
    if (!documentId) {
      setState({ kind: "absent" });
      return;
    }
    const abort = new AbortController();
    let binding: LiveDocumentBinding | null = null;
    const bindingOwner = `${hostId.current}:attempt:${++attemptRef.current}`;
    attemptedRevision.current = latestRevision.current;
    setState({ kind: "opening", documentId });
    void (async () => {
      try {
        const opened = await opener.open({
          source: "server",
          projectId,
          documentId,
          signal: abort.signal,
        });
        if (opened.kind !== "opened") throw new Error("Document is not available");
        const candidate = await opened.admission.bind(bindingOwner);
        if (abort.signal.aborted) {
          candidate.release();
          return;
        }
        binding = candidate;
        setState({
          kind: "opened",
          documentId,
          generation: candidate.generation,
          session: candidate.session,
        });
      } catch {
        if (!abort.signal.aborted) setState({ kind: "failed", documentId });
      }
    })();
    return () => {
      abort.abort();
      binding?.release();
    };
  }, [documentId, opener, projectId, retryGeneration]);

  const retry = useCallback(() => setRetryGeneration((value) => value + 1), []);

  const session = state.kind === "opened" ? state.session : null;
  useEffect(() => {
    if (!session) return setDenied(false);
    return session.subscribe((snapshot) => setDenied(liveSessionDenied(snapshot)));
  }, [session]);

  const unavailable = state.kind === "failed" || denied;
  useEffect(() => {
    if (!unavailable || attemptedRevision.current === availabilityRevision) return;
    attemptedRevision.current = availabilityRevision;
    retry();
  }, [availabilityRevision, retry, unavailable]);

  return useMemo(() => ({ state, retry }), [retry, state]);
}
