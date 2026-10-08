/**
 * useWorkReviewScope — the review scope that lists and runs commands for the
 * route Work on the Work page. The route Work can differ from the Editor's Work
 * and from the chat's, so the rule is one place: the Editor's scope when the
 * Editor has this Work (so a command on its open review is the Editor's own),
 * else the chat's when the chat has it, else the third scope the project shell
 * mounts for exactly this case (`ProjectView`). The third scope never enters an
 * inline review and shares no state with the other two; the command record is
 * the one authority across all three.
 */
import { createContext, type ReactNode, useContext } from "react";
import {
  type DraftReviewContextValue,
  useEditorDraftReview,
} from "@/features/draft-review/DraftReviewProvider";

type WorkReviewScopes = { chat: DraftReviewContextValue; third: DraftReviewContextValue };

const WorkReviewScopesContext = createContext<WorkReviewScopes | null>(null);

/** Offers the chat's and the third scope to the Work page; the Editor's comes from `EditorReviewScope`. */
export function WorkReviewScopesProvider({
  chat,
  third,
  children,
}: WorkReviewScopes & { children: ReactNode }) {
  return (
    <WorkReviewScopesContext.Provider value={{ chat, third }}>
      {children}
    </WorkReviewScopesContext.Provider>
  );
}

/** The scope that covers this Work, or null while none does (the route Work is still resolving). */
export function useWorkReviewScope(workId: string): DraftReviewContextValue | null {
  const editor = useEditorDraftReview();
  const scopes = useContext(WorkReviewScopesContext);
  if (editor.controller.workId === workId) return editor;
  if (scopes?.chat.controller.workId === workId) return scopes.chat;
  if (scopes?.third.controller.workId === workId) return scopes.third;
  return null;
}
