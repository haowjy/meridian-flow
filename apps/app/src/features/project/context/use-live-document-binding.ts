/** One concrete desktop/mobile host's ordinary live-document binding, with retry. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentSession } from "@/core/editor/document-session";
import type { LiveDocumentBinding } from "./open-project-document";
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

export function useLiveDocumentBinding({
  projectId,
  documentId,
  owner,
}: {
  projectId: string;
  documentId: string | null;
  owner: "desktop-document-host" | "mobile-project-document-host";
}): LiveDocumentHostBinding {
  const opener = useProjectDocumentLiveOpener();
  const hostId = useRef(`${owner}:${++hostSequence}`);
  const attemptRef = useRef(0);
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
  return useMemo(() => ({ state, retry }), [retry, state]);
}
