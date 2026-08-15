/** Latest-wins command handoff from any project surface to the Editor review scope. */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useContextTabsActions } from "@/client/stores";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { contextTabFromDraftGroup } from "../context/context-tab-from-draft";
import type { OpenContextRoute } from "../routing/ProjectContextRoute";
import type { AiDraftLaunchTarget } from "./useAiDraftLauncher";

type EditorReviewIntent = AiDraftLaunchTarget & { sequence: number };

type EditorReviewCommand = (target: AiDraftLaunchTarget) => Promise<void>;

const EditorReviewCommandContext = createContext<EditorReviewCommand | null>(null);
const EditorReviewIntentContext = createContext<{
  intent: EditorReviewIntent | null;
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
  const { openTab } = useContextTabsActions();
  const [intent, setIntent] = useState<EditorReviewIntent | null>(null);
  const sequence = useRef(0);
  const latest = useRef<EditorReviewIntent | null>(null);

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

  return (
    <EditorReviewCommandContext.Provider value={openEditorReview}>
      <EditorReviewIntentContext.Provider value={{ intent, claim }}>
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
