/**
 * The draft review's real composition for tests that claim a cross-surface
 * outcome: the Editor's and the Chat's scopes over one Work, their controllers,
 * mutations and query cache, with the header's model reading the Editor's. The
 * suite supplies the network (`@/client/api/drafts-api`) and the two seams the
 * scope reads from the account (`account-feature-context`, the catalog); none of
 * the review's own state is faked or set by hand.
 */
import type { Work } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
  useDraftReviewScopeValue,
} from "@/features/chat/DraftReviewProvider";
import { type ReviewHeaderModel, useReviewHeader } from "@/features/draft-review/useReviewHeader";
import { withReactRoot } from "./react-dom-harness";

export const work = {
  id: "work-a",
  projectId: "project-a",
  name: "Work A",
  archivedAt: null,
} as Work;

export const listed = {
  draftId: "draft-a",
  documentId: "document-a",
  documentName: "Chapter 12",
  status: "active",
  lastActorTurnId: "turn-1",
  updatedAt: "2026-10-07T00:00:00.000Z",
};

export const operation = (id: string) => ({
  operationId: id,
  closureClassId: `class-${id}`,
  kind: "agent",
  contribution: "added",
  classification: "addition",
  hunkCount: 1,
});

export const preview = {
  status: "active",
  draftId: "draft-a",
  inlineModelPresent: true,
  reviewRoomName: "review-room-a",
  liveRevisionToken: "live-1",
  draftRevisionToken: "draft-1",
  operations: [operation("1"), operation("2")],
  hunks: [],
};

/** A preview holding only these changes. */
export const previewOf = (...ids: string[]) => ({ ...preview, operations: ids.map(operation) });

export const change = (id: string) => ({ classId: `class-${id}`, operationIds: [id] });

export const applied = (draftClosed: boolean, id = "2") => ({
  status: "applied",
  draftId: "draft-a",
  operationIds: [id],
  closureClassIds: [`class-${id}`],
  draftClosed,
});

export const discarded = (draftClosed: boolean) => ({
  status: "discarded",
  draftId: "draft-a",
  draftClosed,
});

export type ScopeProbe = {
  /** The Editor's scope: where a review lives and per-change commands run. */
  editor: DraftReviewContextValue;
  /** The Chat's scope: the composer's whole-draft commands. */
  chat: DraftReviewContextValue;
  /** What the header, the dock's list and the editor's chrome read, for the reviewed draft. */
  header: ReviewHeaderModel;
};

export type ReviewedDraft = { documentId: string; draftId: string };

export function renderReviewScopes(
  run: (probe: () => ScopeProbe) => Promise<void>,
  options: { reviewed?: ReviewedDraft } = {},
): Promise<void> {
  const { reviewed = { documentId: "document-a", draftId: "draft-a" } } = options;
  const current: Partial<ScopeProbe> = {};
  function HeaderProbe() {
    current.header = useReviewHeader({ ...reviewed, onOpenDraft: () => {} });
    return null;
  }
  function Scopes(): ReactNode {
    const editor = useDraftReviewScopeValue({ projectId: "project-a", work });
    const chat = useDraftReviewScopeValue({ projectId: "project-a", work, threadId: "thread-a" });
    current.editor = editor;
    current.chat = chat;
    return (
      <DraftReviewBoundary value={editor}>
        <HeaderProbe />
      </DraftReviewBoundary>
    );
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return withReactRoot(
    <QueryClientProvider client={queryClient}>
      <Scopes />
    </QueryClientProvider>,
    () => run(() => current as ScopeProbe),
  );
}
