/** Latest-wins command handoff from any project surface to the Editor review scope. */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useContextTabsActions } from "@/client/stores";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { contextTabFromDraftGroup } from "../context/context-tab-from-draft";
import type { AdmittedLiveDocument } from "../context/open-project-document";
import type {
  LiveDocumentAcknowledgement,
  LiveDocumentHostBinding,
} from "../context/use-live-document-binding";
import type { OpenContextRoute } from "../routing/ProjectContextRoute";

export type AiDraftLaunchTarget = {
  workId: string;
  documentId: string;
  draftId: string;
  contextPath: string;
  documentName?: string;
  isNewDocument?: boolean;
};

type EditorReviewIntent = AiDraftLaunchTarget & { sequence: number };

type EditorReviewCommand = (target: AiDraftLaunchTarget) => Promise<void>;

const EditorReviewCommandContext = createContext<EditorReviewCommand | null>(null);
const EditorReviewIntentContext = createContext<{
  intent: EditorReviewIntent | null;
  claim: (sequence: number) => void;
} | null>(null);

type LiveBindingRequest = {
  sequence: number;
  admission: AdmittedLiveDocument;
  signal: AbortSignal;
};
type LiveBindingHandoff = {
  request: LiveBindingRequest | null;
  claim(sequence: number, owner: object): boolean;
  complete(sequence: number, owner: object, result: LiveDocumentAcknowledgement): void;
};
type AcknowledgeLiveBinding = (
  admission: AdmittedLiveDocument,
  signal: AbortSignal,
) => Promise<LiveDocumentAcknowledgement>;

const AcknowledgeLiveBindingContext = createContext<AcknowledgeLiveBinding | null>(null);
const LiveBindingHandoffContext = createContext<LiveBindingHandoff | null>(null);

export function EditorReviewHandoffProvider({
  projectId,
  openContextRoute,
  children,
}: {
  projectId: string;
  openContextRoute: OpenContextRoute;
  children: ReactNode;
}) {
  const { openTab } = useContextTabsActions();
  const [intent, setIntent] = useState<EditorReviewIntent | null>(null);
  const sequence = useRef(0);
  const latest = useRef<EditorReviewIntent | null>(null);
  const bindingSequence = useRef(0);
  const bindingMounted = useRef(true);
  const bindingRequest = useRef<{
    sequence: number;
    owner: object | null;
    abort: AbortController;
    settle: (result: LiveDocumentAcknowledgement) => void;
  } | null>(null);
  const [advertisedBinding, setAdvertisedBinding] = useState<LiveBindingRequest | null>(null);

  const openEditorReview = useCallback<EditorReviewCommand>(
    async (target) => {
      const staged = { ...target, sequence: ++sequence.current };
      latest.current = staged;
      // Supersession cancels any advertised intent immediately. The new one
      // does not become claimable until its route command has committed.
      setIntent(null);

      const tab = contextTabFromDraftGroup(target);
      if (tab) openTab(projectId, tab);

      try {
        await openContextRoute({
          scheme: "manuscript",
          path: target.contextPath,
          workId: target.workId,
        });
        if (latest.current?.sequence === staged.sequence) {
          setIntent(staged);
        }
      } catch (error) {
        if (latest.current?.sequence === staged.sequence) {
          latest.current = null;
          setIntent(null);
        }
        throw error;
      }
    },
    [openContextRoute, openTab, projectId],
  );
  const claim = useCallback((claimedSequence: number) => {
    if (latest.current?.sequence !== claimedSequence) return;
    latest.current = null;
    setIntent(null);
  }, []);

  const acknowledgeLiveBinding = useCallback<AcknowledgeLiveBinding>((admission, signal) => {
    bindingRequest.current?.settle({ kind: "cancelled" });
    const requestSequence = ++bindingSequence.current;
    const abort = new AbortController();
    return new Promise<LiveDocumentAcknowledgement>((resolve) => {
      let settled = false;
      const timeout = globalThis.setTimeout(() => settle({ kind: "unclaimed" }), 1_000);
      const settle = (result: LiveDocumentAcknowledgement) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        abort.abort();
        signal.removeEventListener("abort", cancel);
        if (bindingRequest.current?.sequence === requestSequence) {
          bindingRequest.current = null;
          if (bindingMounted.current) setAdvertisedBinding(null);
        }
        resolve(result);
      };
      const cancel = () => settle({ kind: "cancelled" });
      signal.addEventListener("abort", cancel, { once: true });
      bindingRequest.current = {
        sequence: requestSequence,
        owner: null,
        abort,
        settle,
      };
      if (signal.aborted) {
        cancel();
        return;
      }
      setAdvertisedBinding({ sequence: requestSequence, admission, signal: abort.signal });
    });
  }, []);
  const claimLiveBinding = useCallback((requestSequence: number, owner: object) => {
    const request = bindingRequest.current;
    if (!request || request.sequence !== requestSequence || request.owner) return false;
    request.owner = owner;
    return true;
  }, []);
  const completeLiveBinding = useCallback(
    (requestSequence: number, owner: object, result: LiveDocumentAcknowledgement) => {
      const request = bindingRequest.current;
      if (!request || request.sequence !== requestSequence || request.owner !== owner) return;
      request.settle(result);
    },
    [],
  );
  const liveBindingHandoff = useMemo<LiveBindingHandoff>(
    () => ({
      request: advertisedBinding,
      claim: claimLiveBinding,
      complete: completeLiveBinding,
    }),
    [advertisedBinding, claimLiveBinding, completeLiveBinding],
  );

  useEffect(() => {
    bindingMounted.current = true;
    return () => {
      bindingMounted.current = false;
      bindingRequest.current?.settle({ kind: "cancelled" });
    };
  }, []);

  return (
    <EditorReviewCommandContext.Provider value={openEditorReview}>
      <AcknowledgeLiveBindingContext.Provider value={acknowledgeLiveBinding}>
        <EditorReviewIntentContext.Provider value={{ intent, claim }}>
          <LiveBindingHandoffContext.Provider value={liveBindingHandoff}>
            {children}
          </LiveBindingHandoffContext.Provider>
        </EditorReviewIntentContext.Provider>
      </AcknowledgeLiveBindingContext.Provider>
    </EditorReviewCommandContext.Provider>
  );
}

export function useAcknowledgeLiveBinding(): AcknowledgeLiveBinding {
  const command = useContext(AcknowledgeLiveBindingContext);
  if (!command) throw new Error("Draft Apply requires the project Editor handoff owner");
  return command;
}

/** Lets only the matching concrete host consume the one advertised admission. */
export function useLiveBindingAcknowledgementHost(
  projectId: string,
  documentId: string | null,
  host: LiveDocumentHostBinding,
): void {
  const handoff = useContext(LiveBindingHandoffContext);
  const request = handoff?.request ?? null;
  const owner = useRef({});

  useEffect(() => {
    if (!handoff || !request || !documentId) return;
    if (
      request.admission.projectId !== projectId ||
      request.admission.documentId !== documentId ||
      !handoff.claim(request.sequence, owner.current)
    ) {
      return;
    }
    const abort = new AbortController();
    const cancel = () => abort.abort();
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) abort.abort();
    void host
      .adoptAndAcknowledge(request.admission, { signal: abort.signal })
      .then((result) => handoff.complete(request.sequence, owner.current, result));
    return () => {
      request.signal.removeEventListener("abort", cancel);
      abort.abort();
      handoff.complete(request.sequence, owner.current, { kind: "cancelled" });
    };
  }, [documentId, handoff, host.adoptAndAcknowledge, projectId, request]);
}

export function useOpenEditorReview(): EditorReviewCommand {
  const command = useContext(EditorReviewCommandContext);
  if (!command) throw new Error("Opening a draft requires the project review handoff owner");
  return command;
}

/** Mount inside the Editor review boundary, beside the active viewer/editor. */
export function EditorReviewIntentClaimant({
  editorWorkId,
  activeScheme,
  activePath,
}: {
  editorWorkId: string | null;
  activeScheme: string | null;
  activePath: string | null;
}) {
  const handoff = useContext(EditorReviewIntentContext);
  const intent = handoff?.intent ?? null;
  const review = useDraftReview();

  useEffect(() => {
    if (!intent) return;
    if (editorWorkId !== intent.workId) return;
    if (activeScheme !== "manuscript" || activePath !== intent.contextPath) return;
    if (review.activeEditorDocumentId !== intent.documentId) return;
    const group = review.groupForDocument(intent.documentId);
    if (!group?.drafts.some((draft) => draft.draftId === intent.draftId)) return;
    review.controller.enterInlineReview(intent.documentId, intent.draftId);
    handoff?.claim(intent.sequence);
  }, [activePath, activeScheme, editorWorkId, handoff, intent, review]);

  return null;
}
