/**
 * The one review-launch path. Every launcher (the composer strip, a change card, a link to a draft,
 * the Work page, a draft hint, the phone) calls `openAiDraft`; it opens the document's tab, selects
 * it and pins the review on it (`reviewPin`, `view.version = "draft"`). In Write the route command
 * does the opening and writes the URL; beside the chat the tab store does. Latest launch wins.
 * `EditorReviewIntentClaimant` then carries the clicked change's focus to the host that paints it.
 */

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
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { getContextTabs, tabKey, useContextTabsActions, useContextTabsStore } from "@/client/stores";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { appendTraceEvent } from "@/features/debug/trace/trace-store";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import type { ReviewFocus } from "@/features/draft-review/review-model";
import type { LinkDestination } from "@/features/links";
import type { ContextUri } from "@/lib/context-uri";
import { contextTabFromDraftGroup } from "./context/context-tab-from-draft";
import { BesideChatContext } from "./context/open-chat-document";
import { claimOpenIntent } from "./context/open-intent";
import { useProjectDocumentNavigationProjectId } from "./context/open-project-document";
import { FocusOpenedReview, type ReviewFocusRequest } from "./dock/FocusOpenedReview";
import { type PresentedDocument, usePresentedDocument } from "./presented-document";
import type { OpenContextRoute } from "./routing/ProjectNavigationContext";

export type AiDraftLaunchTarget = {
  workId: string;
  documentId: string;
  itemKey: string;
  contextLocation: Pick<ContextUri, "scheme" | "path">;
  documentName?: string;
  /** Live doesn't hold the document (created by the draft, or deleted live): the tab is draft-only. */
  draftOnly?: boolean;
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

  const beside = useContext(BesideChatContext);
  const openEditorReview = useCallback<EditorReviewCommand>(
    async (target) => {
      const tab = contextTabFromDraftGroup(target);
      // Beside the chat the tab store opens, selects and pins; there is no address to route to.
      if (beside && tab) {
        beside(tab, claimOpenIntent(), undefined, {
          workId: target.workId,
          itemKey: target.itemKey,
        });
        return;
      }
      const staged = { ...target, sequence: ++sequence.current };
      latest.current = staged;
      claimed.current = null;
      setRoutingItemKey(target.itemKey);
      // A matching mounted Editor may claim immediately. This avoids making a
      // same-route review command depend on an unrelated navigation settlement.
      setIntent(staged);

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
            const opened = getContextTabs(projectId).tabs.find(
              (candidate) => candidate.documentId === target.documentId,
            );
            if (opened)
              useContextTabsStore.getState().setTabState(projectId, tabKey(opened), {
                reviewPin: { workId: target.workId, itemKey: target.itemKey },
                view: { version: "draft" },
              });
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
    [openContextRoute, projectId, beside],
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

export function useAiDraftLauncher() {
  const openEditorReview = useOpenEditorReview();
  const openAiDraft = useCallback(
    (target: AiDraftLaunchTarget) => {
      void openEditorReview(target).catch((error) => {
        console.error("[editor-review] launch failed", error);
      });
    },
    [openEditorReview],
  );

  /** Opens a listed draft in review. A draft with no address yet (still being written) has nothing to open. */
  const openReviewFile = useCallback(
    (row: ReviewFileTarget, workId: string, focus?: ReviewFocus) =>
      row.contextLocation &&
      openAiDraft({
        workId,
        documentId: row.documentId,
        itemKey: row.draft.itemKey,
        contextLocation: row.contextLocation,
        documentName: row.documentName ?? undefined,
        draftOnly: row.draftOnly,
        ...(focus ? { focus } : {}),
      }),
    [openAiDraft],
  );

  return { openAiDraft, openReviewFile };
}

/**
 * A link destination that sends a document living only in a draft to that
 * Work's review (by item identity, as the review launch does), and every
 * other document to the surface's own live opener.
 */
export function useReviewingLinkDestination(open: LinkDestination): LinkDestination {
  const openEditorReview = useOptionalOpenEditorReview();
  const projectId = useProjectDocumentNavigationProjectId();
  const { openTab } = useContextTabsActions();
  return useCallback(
    (document, gesture) => {
      const { review } = document;
      if (!review) return open(document, gesture);
      // A hidden target exists only in the draft: it is a draft-only review, never a live tab.
      const target: AiDraftLaunchTarget = {
        documentId: document.documentId,
        ...review,
        draftOnly: true,
      };
      if (gesture === "new-tab") {
        // The writer keeps their place: the review joins the tab strip without a route change.
        const tab = contextTabFromDraftGroup(target);
        if (projectId && tab) openTab(projectId, tab);
        return Promise.resolve();
      }
      if (!openEditorReview)
        throw new Error("Opening a draft requires the project review handoff owner");
      return openEditorReview(target).catch((error) => {
        console.error("[editor-review] launch failed", error);
      });
    },
    [open, openEditorReview, projectId, openTab],
  );
}
