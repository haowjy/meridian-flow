import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentSession } from "@/core/editor/document-session";
import { useAccountEpochSignal } from "./account-feature-context";
import type { LiveDocumentBinding, ProjectDocumentLiveOpenResult } from "./open-project-document";
import { useProjectDocumentLiveOpener } from "./project-document-live-opener-context";

export type LiveDocumentBindingState =
  | { kind: "absent" }
  | { kind: "opening"; documentId: string }
  | { kind: "opened"; documentId: string; session: DocumentSession }
  | {
      kind: "failed";
      documentId: string;
      reason: Extract<ProjectDocumentLiveOpenResult, { kind: "unavailable" }>["reason"];
    };

export type LiveDocumentHostBinding = {
  state: LiveDocumentBindingState;
  retry(): void;
};

let hostSequence = 0;

export function useLiveDocumentBinding({
  projectId,
  documentId,
  owner,
  trashed,
  workOnly,
  draftId,
}: {
  projectId: string;
  documentId: string | null;
  owner: "desktop-document-host" | "mobile-project-document-host" | "trash-view";
  trashed?: true;
  workOnly?: true;
  draftId?: string;
}): LiveDocumentHostBinding {
  const opener = useProjectDocumentLiveOpener();
  const accountSignal = useAccountEpochSignal();
  const hostId = useRef(`${owner}:${++hostSequence}`);
  const attemptRef = useRef(0);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [state, setState] = useState<LiveDocumentBindingState>(
    documentId ? { kind: "opening", documentId } : { kind: "absent" },
  );

  useEffect(() => {
    if (!documentId) {
      setState({ kind: "absent" });
      return;
    }
    const abort = new AbortController();
    let binding: LiveDocumentBinding | null = null;
    let stopSession = () => {};
    const bindingOwner = `${hostId.current}:attempt:${++attemptRef.current}`;
    setState({ kind: "opening", documentId });
    void (async () => {
      try {
        const opened = await opener.open({
          projectId,
          documentId,
          trashed,
          workOnly,
          ...(draftId ? { draftId } : {}),
          signal: abort.signal,
        });
        if (opened.kind === "cancelled") return;
        if (opened.kind !== "opened") {
          if (opened.kind === "unavailable") {
            reportError(new Error(`Document is not available (${opened.reason})`));
            setState({ kind: "failed", documentId, reason: opened.reason });
            return;
          }
          setState({ kind: "failed", documentId, reason: "failed" });
          return;
        }
        const candidate = await opened.admission.bind(bindingOwner);
        if (abort.signal.aborted) {
          candidate.release();
          return;
        }
        binding = candidate;
        setState({
          kind: "opened",
          documentId,
          session: candidate.session,
        });
        stopSession = candidate.subscribeSession((session) =>
          setState({ kind: "opened", documentId, session }),
        );
      } catch (error) {
        if (abort.signal.aborted || accountSignal.aborted) return;
        reportError(error);
        setState({ kind: "failed", documentId, reason: "failed" });
      }
    })();
    return () => {
      abort.abort();
      stopSession();
      binding?.release();
    };
  }, [accountSignal, documentId, draftId, opener, projectId, retryGeneration, trashed, workOnly]);

  const retry = useCallback(() => setRetryGeneration((value) => value + 1), []);
  return useMemo(() => ({ state, retry }), [retry, state]);
}
