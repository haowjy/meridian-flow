/** Latest-wins command handoff from any project surface to the Editor review scope. */

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
import {
  clearDraftReviewLaunchFailure,
  failDraftReviewLaunch,
} from "@/client/query/draft-command-record";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { appendTraceEvent } from "@/features/debug/trace/trace-store";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { contextTabFromDraftGroup } from "../context/context-tab-from-draft";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import { ReviewHandoverContext, useReviewHandoverOwner } from "./review-handover";

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
      draftId: target.draftId,
    },
  };
  appendTraceEvent(event);
}

const EditorReviewCommandContext = createContext<EditorReviewCommand | null>(null);
const EditorReviewIntentContext = createContext<{
  intent: EditorReviewIntent | null;
  routingDraftId: string | null;
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
  const [routingDraftId, setRoutingDraftId] = useState<string | null>(null);
  const handover = useReviewHandoverOwner();
  const { begin: beginHandover, release: releaseHandover } = handover;
  const sequence = useRef(0);
  const latest = useRef<EditorReviewIntent | null>(null);
  const claimed = useRef<number | null>(null);

  const openEditorReview = useCallback<EditorReviewCommand>(
    async (target) => {
      const draft = {
        projectId,
        workId: target.workId,
        documentId: target.documentId,
        draftId: target.draftId,
      };
      // A new attempt retires the previous attempt's message.
      clearDraftReviewLaunchFailure(draft);
      // Navigation happens first; what is painted stays until the review being opened has painted.
      const held = beginHandover({
        documentId: target.documentId,
        draftId: target.draftId,
        documentName: target.documentName,
      });
      const staged = { ...target, sequence: ++sequence.current };
      latest.current = staged;
      claimed.current = null;
      setRoutingDraftId(target.draftId);
      // A matching mounted Editor may claim immediately. This avoids making a
      // same-route review command depend on an unrelated navigation settlement.
      setIntent(staged);

      const tab = contextTabFromDraftGroup(target);

      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = await openContextRoute(
            {
              scheme: "manuscript",
              path: target.contextPath,
              workId: target.workId,
              documentId: target.documentId,
            },
            {
              replaceIfSameDocument: true,
              tab: tab ?? undefined,
              draftId: target.draftId,
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
            releaseHandover(held);
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
        // The failure belongs on the draft the writer tried to open.
        releaseHandover(held);
        failDraftReviewLaunch(draft);
        throw error;
      } finally {
        if (latest.current?.sequence === staged.sequence || claimed.current === staged.sequence) {
          setRoutingDraftId(null);
        }
      }
    },
    [beginHandover, openContextRoute, projectId, releaseHandover],
  );
  const claim = useCallback((claimedSequence: number) => {
    if (latest.current?.sequence !== claimedSequence) return;
    claimed.current = claimedSequence;
    setIntent(null);
  }, []);

  return (
    <EditorReviewCommandContext.Provider value={openEditorReview}>
      <EditorReviewIntentContext.Provider value={{ intent, routingDraftId, claim }}>
        <ReviewHandoverContext.Provider value={handover}>{children}</ReviewHandoverContext.Provider>
      </EditorReviewIntentContext.Provider>
    </EditorReviewCommandContext.Provider>
  );
}

export function useOpenEditorReview(): EditorReviewCommand {
  const command = useContext(EditorReviewCommandContext);
  if (!command) throw new Error("Opening a draft requires the project review handoff owner");
  return command;
}

/** Draft currently crossing the route-to-Editor handoff, if any. */
export function usePendingEditorReviewDraftId(): string | null {
  return useContext(EditorReviewIntentContext)?.routingDraftId ?? null;
}

/**
 * Mount inside the Editor review boundary, beside the active viewer/editor. The
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

  useEffect(() => {
    if (!intent) return;
    if (editorWorkId !== intent.workId) return;
    if (activeScheme !== "manuscript") return;
    if (review.activeEditorDocumentId !== intent.documentId) return;
    const group = review.groupForDocument(intent.documentId);
    if (group?.draft.draftId !== intent.draftId) return;
    review.controller.enterInlineReview(intent.documentId, intent.draftId);
    handoff?.claim(intent.sequence);
  }, [activeScheme, editorWorkId, handoff, intent, review]);

  return null;
}
