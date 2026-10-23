/** One concrete desktop/mobile host's ordinary live-document binding, with retry. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentSession } from "@/core/editor/document-session";
import type {
  AvailableOpenResolution,
  LiveDocumentBinding,
  ProjectDocumentLiveOpenResult,
} from "./open-project-document";
import { useProjectDocumentLiveOpener } from "./project-document-live-opener-context";

export type LiveDocumentBindingState =
  | { kind: "absent" }
  | { kind: "opening"; documentId: string }
  | { kind: "opened"; documentId: string; generation: string; session: DocumentSession }
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
  tabInstanceId,
}: {
  projectId: string;
  documentId: string | null;
  owner: "desktop-document-host" | "mobile-project-document-host";
  tabInstanceId?: string;
}): LiveDocumentHostBinding {
  const opener = useProjectDocumentLiveOpener();
  const hostId = useRef(`${owner}:${++hostSequence}`);
  const attemptRef = useRef(0);
  const firstResolution = useRef<AvailableOpenResolution | null | undefined>(undefined);
  const [retryGeneration, setRetryGeneration] = useState(0);
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
    if (firstResolution.current === undefined)
      firstResolution.current = tabInstanceId
        ? opener.takeTransfer(tabInstanceId, documentId)
        : null;
    setState({ kind: "opening", documentId });
    void (async () => {
      try {
        const opened = await opener.open({
          source: "server",
          projectId,
          documentId,
          signal: abort.signal,
          attempt: retryGeneration === 0 ? "first" : "retry",
          resolution: retryGeneration === 0 ? (firstResolution.current ?? undefined) : undefined,
        });
        // Account shutdown cancels the open without aborting this effect; that is teardown, not a failure.
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
          generation: candidate.generation,
          session: candidate.session,
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        reportError(error);
        setState({ kind: "failed", documentId, reason: "failed" });
      }
    })();
    return () => {
      abort.abort();
      binding?.release();
    };
  }, [documentId, opener, projectId, retryGeneration, tabInstanceId]);

  const retry = useCallback(() => setRetryGeneration((value) => value + 1), []);
  return useMemo(() => ({ state, retry }), [retry, state]);
}
