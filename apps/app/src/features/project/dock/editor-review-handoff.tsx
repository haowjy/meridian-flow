/** Latest-wins command handoff from any project surface to a review launched in the Editor. */

import type { EventRecord } from "@meridian/contracts/observability";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { appendTraceEvent } from "@/features/debug/trace/trace-store";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import type { ReviewFocus } from "@/features/draft-review/review-model";
import type { ContextUri } from "@/lib/context-uri";
import { contextTabFromDraftGroup } from "../context/context-tab-from-draft";
import { type PresentedDocument, usePresentedDocument } from "../presented-document";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import { FocusOpenedReview, type ReviewFocusRequest } from "./FocusOpenedReview";

export type AiDraftLaunchTarget = {
  workId: string;
  documentId: string;
  itemKey: string;
  contextLocation: Pick<ContextUri, "scheme" | "path">;
  documentName?: string;
  isNew?: boolean;
  /** A projection-local change to focus, only if that projection still paints. */
  focus?: ReviewFocus;
};

type EditorReviewIntent = AiDraftLaunchTarget & { sequence: number };

type EditorReviewCommand = (target: AiDraftLaunchTarget) => Promise<void>;

function reportRouteSettlement(
  projectId: string,
  target: AiDraftLaunchTarget,
  kind: "applied" | "cancelled" | "superseded" | "failed",
  attempt: number,
): void {
  if (!DEBUG_FEATURE_ALLOWED) return;
  const event: EventRecord = {
    timestamp: new Date().toISOString(),
    level: kind === "failed" ? "error" : kind === "applied" ? "info" : "warn",
    source: "project.review",
    name: "editor_review.route_settlement",
    sensitivity: "safe",
    correlation: { projectId },
    payload: {
      kind,
      attempt,
      workId: target.workId,
      documentId: target.documentId,
      itemKey: target.itemKey,
    },
  };
  appendTraceEvent(event);
}

const EditorReviewCommandContext = createContext<EditorReviewCommand | null>(null);
const EditorReviewIntentContext = createContext<{
  intent: EditorReviewIntent | null;
  routingItemKey: string | null;
  claim: (sequence: number) => void;
} | null>(null);

export function EditorReviewHandoffProvider({
  projectId,
  openContextRoute,
  children,
}: {
  projectId: string;
  openContextRoute: OpenContextRoute;
  children: ReactNode;
}) {
  const [intent, setIntent] = useState<EditorReviewIntent | null>(null);
  const [routingItemKey, setRoutingItemKey] = useState<string | null>(null);
  const sequence = useRef(0);
  const latest = useRef<EditorReviewIntent | null>(null);
  const claimed = useRef<number | null>(null);

  const openEditorReview = useCallback<EditorReviewCommand>(
    async (target) => {
      const staged = { ...target, sequence: ++sequence.current };
      latest.current = staged;
      claimed.current = null;
      setRoutingItemKey(target.itemKey);
      // A matching mounted Editor may claim immediately. This avoids making a
      // same-route review command depend on an unrelated navigation settlement.
      setIntent(staged);

      const tab = contextTabFromDraftGroup(target);

      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = await openContextRoute(
            {
              ...target.contextLocation,
              workId: target.workId,
              documentId: target.documentId,
            },
            {
              replaceIfSameDocument: true,
              tab: tab ?? undefined,
              itemKey: target.itemKey,
              canCommit: () => latest.current?.sequence === staged.sequence,
            },
          );
          reportRouteSettlement(projectId, target, result.kind, attempt + 1);
          if (result.kind === "failed") throw result.error;
          if (result.kind === "applied") {
            if (
              latest.current?.sequence === staged.sequence &&
              claimed.current === staged.sequence
            ) {
              latest.current = null;
            }
            return;
          }
          if (result.kind === "cancelled") {
            if (latest.current?.sequence === staged.sequence) {
              latest.current = null;
              setIntent(null);
            }
            return;
          }
          if (latest.current?.sequence !== staged.sequence) return;
        }
        throw new Error("Editor review navigation did not settle after retry");
      } catch (error) {
        if (latest.current?.sequence === staged.sequence) {
          latest.current = null;
          setIntent(null);
        }
        throw error;
      } finally {
        if (latest.current?.sequence === staged.sequence || claimed.current === staged.sequence) {
          setRoutingItemKey(null);
        }
      }
    },
    [openContextRoute, projectId],
  );
  const claim = useCallback((claimedSequence: number) => {
    if (latest.current?.sequence !== claimedSequence) return;
    claimed.current = claimedSequence;
    setIntent(null);
  }, []);

  return (
    <EditorReviewCommandContext.Provider value={openEditorReview}>
      <EditorReviewIntentContext.Provider value={{ intent, routingItemKey, claim }}>
        {children}
      </EditorReviewIntentContext.Provider>
    </EditorReviewCommandContext.Provider>
  );
}

export function useOpenEditorReview(): EditorReviewCommand {
  const command = useContext(EditorReviewCommandContext);
  if (!command) throw new Error("Opening a draft requires the project review handoff owner");
  return command;
}

/** For a surface that only sometimes launches a review (a link to a draft), and may mount without an owner. */
export function useOptionalOpenEditorReview(): EditorReviewCommand | null {
  return useContext(EditorReviewCommandContext);
}

/**
 * Draft currently crossing the route-to-Editor handoff, if any: its route
 * command is running, or its launch is waiting for the Editor to claim it (the
 * route can settle before the Editor mounts the document). The address owner
 * restores no review for it meanwhile; a restore is a second launch, and the
 * latest one decides which change the review opens on.
 */
export function usePendingEditorReviewItemKey(): string | null {
  const handoff = useContext(EditorReviewIntentContext);
  return handoff?.routingItemKey ?? handoff?.intent?.itemKey ?? null;
}

/**
 * Mount inside the Editor host’s draft-review boundary, beside the active viewer/editor. The
 * Work, document and draft decide the claim; the address path is only a label
 * that a rename can change between the launch and the claim.
 */
export function EditorReviewIntentClaimant({
  editorWorkId,
  activeScheme,
}: {
  editorWorkId: string | null;
  activeScheme: string | null;
}) {
  const handoff = useContext(EditorReviewIntentContext);
  const intent = handoff?.intent ?? null;
  const review = useDraftReview();
  const [focus, setFocus] = useState<ReviewFocusRequest | null>(null);
  const focusDone = useCallback(() => setFocus(null), []);

  useEffect(() => {
    if (
      !intent ||
      !admissible(intent, { editorWorkId, activeScheme, documentId: review.activeEditorDocumentId })
    )
      return;
    review.controller.enterInlineReview(intent.documentId, intent.itemKey);
    // The latest launch decides the focus: one without it clears an older request.
    setFocus(
      intent.focus
        ? {
            sequence: intent.sequence,
            documentId: intent.documentId,
            itemKey: intent.itemKey,
            focus: intent.focus,
          }
        : null,
    );
    handoff?.claim(intent.sequence);
  }, [activeScheme, editorWorkId, handoff, intent, review]);

  return focus ? (
    <FocusOpenedReview key={focus.sequence} request={focus} onDone={focusDone} />
  ) : null;
}

/** The launch and its host agree on the destination before passive admission. */
export function admissible(
  intent: EditorReviewIntent,
  host: { editorWorkId: string | null; activeScheme: string | null; documentId: string | null },
) {
  return intent.workId === host.editorWorkId && intent.documentId === host.documentId;
}
export function useRequestedReview(host: {
  container: PresentedDocument["container"];
  editorWorkId: string | null;
  activeScheme: string | null;
  documentId: string | null;
}) {
  const { controller } = useDraftReview();
  const intent = useContext(EditorReviewIntentContext)?.intent;
  const presented = usePresentedDocument();
  return requestedReviewItemKey(host, { inlineReview: controller.inlineReview, intent, presented });
}

/** Pending intent hides warm live paint; an admitted review survives route failure. */
export function requestedReviewItemKey(
  host: {
    container: PresentedDocument["container"];
    editorWorkId: string | null;
    activeScheme: string | null;
    documentId: string | null;
  },
  state: {
    inlineReview: { documentId: string; itemKey: string } | null;
    intent: EditorReviewIntent | null | undefined;
    presented: PresentedDocument | null;
  },
): string | null {
  const { inlineReview, intent, presented } = state;
  const presenting =
    presented?.container === host.container &&
    (presented.documentId === host.documentId ||
      (!presented.documentId && host.container === "editor"));
  return presenting && inlineReview?.documentId === host.documentId
    ? inlineReview.itemKey
    : host.container === "editor" && intent && admissible(intent, host)
      ? intent.itemKey
      : presenting && presented?.documentId === host.documentId
        ? (presented.review?.itemKey ?? null)
        : null;
}
