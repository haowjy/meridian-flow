/** One concrete desktop/mobile host's live binding and Apply acknowledgement. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentSession } from "@/core/editor/document-session";
import type { AdmittedLiveDocument, LiveDocumentBinding } from "./open-project-document";
import { useProjectDocumentLiveOpener } from "./project-document-live-opener-context";

export type LiveDocumentBindingState =
  | { kind: "absent" }
  | { kind: "opening"; documentId: string }
  | { kind: "opened"; documentId: string; session: DocumentSession }
  | { kind: "failed"; documentId: string };

export type LiveDocumentAcknowledgement =
  | { kind: "acknowledged"; projectId: string; documentId: string; generation: string }
  | { kind: "cancelled" | "stale" | "unusable" | "unclaimed" };

export type LiveDocumentHostBinding = {
  state: LiveDocumentBindingState;
  retry(): void;
  adoptAndAcknowledge(
    admission: AdmittedLiveDocument,
    options: { signal: AbortSignal; timeoutMs?: number },
  ): Promise<LiveDocumentAcknowledgement>;
};

type InstalledBinding = { binding: LiveDocumentBinding; attempt: number };
type PendingBinding = { attempt: number; abort: AbortController; operation: "ordinary" | "apply" };

let hostSequence = 0;

export function useLiveDocumentBinding({
  projectId,
  documentId,
  owner,
}: {
  projectId: string;
  documentId: string | null;
  owner: "desktop-server-tab" | "mobile-project-document-host";
}): LiveDocumentHostBinding {
  const opener = useProjectDocumentLiveOpener();
  const hostId = useRef(`${owner}:${++hostSequence}`);
  const desiredRef = useRef({ projectId, documentId, generation: 0, mounted: true });
  const currentRef = useRef<InstalledBinding | null>(null);
  const pendingRef = useRef<PendingBinding | null>(null);
  const ordinaryAbortRef = useRef<AbortController | null>(null);
  const attemptRef = useRef(0);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [state, setState] = useState<LiveDocumentBindingState>(
    documentId ? { kind: "opening", documentId } : { kind: "absent" },
  );

  const runCandidate = useCallback(
    async (
      admission: AdmittedLiveDocument,
      externalSignal: AbortSignal | null,
      requireCurrentSync: boolean,
      timeoutMs = 10_000,
      supersedeOrdinary = true,
      operation: "ordinary" | "apply" = "apply",
    ): Promise<LiveDocumentAcknowledgement> => {
      const desired = desiredRef.current;
      if (
        externalSignal?.aborted ||
        !desired.mounted ||
        desired.projectId !== admission.projectId ||
        desired.documentId !== admission.documentId
      ) {
        return { kind: "stale" };
      }
      if (operation === "ordinary" && pendingRef.current?.operation === "apply")
        return { kind: "stale" };
      if (supersedeOrdinary) ordinaryAbortRef.current?.abort();
      const attempt = ++attemptRef.current;
      pendingRef.current?.abort.abort();
      const abort = new AbortController();
      pendingRef.current = { attempt, abort, operation };
      const forwardAbort = () => abort.abort();
      externalSignal?.addEventListener("abort", forwardAbort, { once: true });
      if (externalSignal?.aborted) abort.abort();
      let candidate: LiveDocumentBinding | null = null;
      let installed = false;
      try {
        if (
          abort.signal.aborted ||
          !desired.mounted ||
          desired.projectId !== admission.projectId ||
          desired.documentId !== admission.documentId
        ) {
          return { kind: "stale" };
        }
        candidate = await admission.bind(`${hostId.current}:attempt:${attempt}`);
        if (
          abort.signal.aborted ||
          pendingRef.current?.attempt !== attempt ||
          desiredRef.current.generation !== desired.generation
        ) {
          return { kind: abort.signal.aborted ? "cancelled" : "stale" };
        }
        if (
          candidate.projectId !== admission.projectId ||
          candidate.documentId !== admission.documentId ||
          candidate.generation !== admission.generation
        ) {
          return { kind: "unusable" };
        }
        if (requireCurrentSync) {
          await waitForCurrentSyncOrAbort(candidate.session, timeoutMs, abort.signal);
          const snapshot = candidate.session.getSnapshot();
          if (snapshot.status !== "synced" || snapshot.schemaFence !== null) {
            return { kind: "unusable" };
          }
        }
        if (
          abort.signal.aborted ||
          pendingRef.current?.attempt !== attempt ||
          desiredRef.current.generation !== desired.generation ||
          desiredRef.current.projectId !== admission.projectId ||
          desiredRef.current.documentId !== admission.documentId
        ) {
          return { kind: abort.signal.aborted ? "cancelled" : "stale" };
        }

        const previous = currentRef.current;
        currentRef.current = { binding: candidate, attempt };
        installed = true;
        setState({ kind: "opened", documentId: admission.documentId, session: candidate.session });
        previous?.binding.release();
        return {
          kind: "acknowledged",
          projectId: admission.projectId,
          documentId: admission.documentId,
          generation: admission.generation,
        };
      } catch {
        return abort.signal.aborted ? { kind: "cancelled" } : { kind: "unusable" };
      } finally {
        externalSignal?.removeEventListener("abort", forwardAbort);
        if (!installed) candidate?.release();
        if (pendingRef.current?.attempt === attempt) pendingRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    const generation = desiredRef.current.generation + 1;
    desiredRef.current = { projectId, documentId, generation, mounted: true };
    pendingRef.current?.abort.abort();
    currentRef.current?.binding.release();
    currentRef.current = null;
    if (!documentId) {
      setState({ kind: "absent" });
      return;
    }

    const abort = new AbortController();
    ordinaryAbortRef.current = abort;
    setState({ kind: "opening", documentId });
    void opener
      .open({ source: "server", projectId, documentId, signal: abort.signal })
      .then((opened) => {
        if (opened.kind !== "opened") return { kind: "unusable" as const };
        if (
          abort.signal.aborted ||
          desiredRef.current.generation !== generation ||
          desiredRef.current.documentId !== documentId
        )
          return { kind: "stale" as const };
        return runCandidate(opened.admission, abort.signal, false, 10_000, false, "ordinary");
      })
      .then((result) => {
        if (
          result.kind !== "acknowledged" &&
          !abort.signal.aborted &&
          desiredRef.current.generation === generation
        ) {
          setState({ kind: "failed", documentId });
        }
      });
    return () => {
      abort.abort();
      if (ordinaryAbortRef.current === abort) ordinaryAbortRef.current = null;
      if (desiredRef.current.generation === generation) {
        desiredRef.current = { projectId, documentId, generation: generation + 1, mounted: false };
        pendingRef.current?.abort.abort();
        currentRef.current?.binding.release();
        currentRef.current = null;
      }
    };
  }, [documentId, opener, projectId, retryGeneration, runCandidate]);

  const retry = useCallback(() => setRetryGeneration((value) => value + 1), []);
  const adoptAndAcknowledge = useCallback(
    (admission: AdmittedLiveDocument, options: { signal: AbortSignal; timeoutMs?: number }) =>
      runCandidate(admission, options.signal, true, options.timeoutMs),
    [runCandidate],
  );

  return useMemo(
    () => ({ state, retry, adoptAndAcknowledge }),
    [adoptAndAcknowledge, retry, state],
  );
}

function waitForCurrentSyncOrAbort(
  session: DocumentSession,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    session.waitForCurrentSync(timeoutMs).then(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
