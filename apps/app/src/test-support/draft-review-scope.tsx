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
import { act, type ReactNode, useState } from "react";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
  useDraftReview,
  useDraftReviewScopeValue,
} from "@/features/draft-review/DraftReviewProvider";
import type { DraftChangesView } from "@/features/draft-review/draft-changes";
import type { ReviewFileTarget } from "@/features/draft-review/review-files";
import {
  type ChangeCommandRunner,
  useChangeCommandRunner,
} from "@/features/draft-review/useChangeCommandRunner";
import { type DraftChangesTarget, useDraftChanges } from "@/features/draft-review/useDraftChanges";
import type { DraftReviewController } from "@/features/draft-review/useDraftReviewController";
import { type ReviewChangesView, useReviewChanges } from "@/features/draft-review/useReviewChanges";
import { type ReviewHeaderModel, useReviewHeader } from "@/features/draft-review/useReviewHeader";
import { withReactRoot } from "./react-dom-harness";

export const work = {
  id: "work-a",
  projectId: "project-a",
  name: "Work A",
  archivedAt: null,
} as Work;

/** A Work neither the Editor nor the Chat has: the Work page's third scope. */
export const workC = {
  id: "work-c",
  projectId: "project-a",
  name: "Work C",
  archivedAt: null,
} as Work;

export const listed = {
  draftId: "draft-a",
  documentId: "document-a",
  documentName: "Chapter 12",
  status: "active",
  lastActorTurnId: "turn-1",
  actorThreads: [],
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

/** The reviewed draft's identity, as a command names it. */
export const draftA = { documentId: "document-a", draftId: "draft-a" };

/** A selection of these changes (one class each). */
export const change = (...ids: string[]) => ({
  classIds: ids.map((id) => `class-${id}`),
  operationIds: ids,
});

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
  queryClient: QueryClient;
  /** The Editor's scope: where a review lives and per-change commands run. */
  editor: DraftReviewContextValue;
  /** The Chat's scope: the composer's whole-draft commands. */
  chat: DraftReviewContextValue;
  /** The third scope: a Work no other scope has. It lists and runs commands, and never enters a review. */
  third: DraftReviewContextValue;
  /** What the header, the dock's list and the editor's chrome read, for the reviewed draft. */
  header: ReviewHeaderModel;
  /** The writer opens another draft of the Work: the header then reads that one. */
  openDraft: (draft: ReviewedDraft) => Promise<void>;
  /** A surface mounts after the review is already open (the dock's tab, a sheet): its view of the Editor's review. */
  mountLateReader: () => Promise<() => ReviewChangesView>;
  /** The transport as the Chat's scope uses it: the strip's and a Work row's way to send. */
  chatRunner: ChangeCommandRunner;
  /** A change list of any draft, read through the Chat's scope (an unopened draft's rows). */
  mountDraftChanges: (
    target: DraftChangesTarget,
    scope?: "chat" | "third",
  ) => Promise<() => DraftChangesView>;
};

export type ReviewedDraft = { documentId: string; draftId: string };

export function renderReviewScopes(
  run: (probe: () => ScopeProbe) => Promise<void>,
  options: { reviewed?: ReviewedDraft; onOpenDraft?: (row: ReviewFileTarget) => void } = {},
): Promise<void> {
  const {
    reviewed: initialReviewed = { documentId: "document-a", draftId: "draft-a" },
    onOpenDraft = () => {},
  } = options;
  const current: Partial<ScopeProbe> = {};
  let lateView: ReviewChangesView | null = null;
  let showLateReader: (() => void) | null = null;
  let addChangeList: ((target: DraftChangesTarget, scope: "chat" | "third") => void) | null = null;
  const changeLists = new Map<DraftChangesTarget, DraftChangesView>();
  function ChangeList({ target, scope }: { target: DraftChangesTarget; scope: "chat" | "third" }) {
    const controller = current[scope]?.controller as DraftReviewController;
    changeLists.set(target, useDraftChanges(target, { controller }));
    return null;
  }
  function RunnerProbe() {
    current.chatRunner = useChangeCommandRunner(current.chat?.controller as DraftReviewController);
    return null;
  }
  function LateReader() {
    lateView = useReviewChanges(useDraftReview().controller);
    return null;
  }
  function HeaderProbe() {
    const [reviewed, setReviewed] = useState(initialReviewed);
    const [lateMounted, setLateMounted] = useState(false);
    const [lists, setLists] = useState<{ target: DraftChangesTarget; scope: "chat" | "third" }[]>(
      [],
    );
    showLateReader = () => setLateMounted(true);
    addChangeList = (target, scope) => setLists((held) => [...held, { target, scope }]);
    current.header = useReviewHeader({ ...reviewed, onOpenDraft });
    current.openDraft = (draft) => act(async () => setReviewed(draft));
    current.mountLateReader = async () => {
      await act(async () => showLateReader?.());
      return () => {
        if (!lateView) throw new Error("The late reader did not mount.");
        return lateView;
      };
    };
    current.mountDraftChanges = async (target, scope = "chat") => {
      await act(async () => addChangeList?.(target, scope));
      return () => {
        const view = changeLists.get(target);
        if (!view) throw new Error("The change list did not mount.");
        return view;
      };
    };
    return (
      <>
        <RunnerProbe />
        {lateMounted ? <LateReader /> : null}
        {lists.map(({ target, scope }) => (
          <ChangeList key={target.draftId} target={target} scope={scope} />
        ))}
      </>
    );
  }
  function Scopes(): ReactNode {
    const editor = useDraftReviewScopeValue({ projectId: "project-a", work });
    const chat = useDraftReviewScopeValue({ projectId: "project-a", work, threadId: "thread-a" });
    const third = useDraftReviewScopeValue({ projectId: "project-a", work: workC });
    current.editor = editor;
    current.chat = chat;
    current.third = third;
    return (
      <DraftReviewBoundary value={editor}>
        <HeaderProbe />
      </DraftReviewBoundary>
    );
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  current.queryClient = queryClient;
  return withReactRoot(
    <QueryClientProvider client={queryClient}>
      <Scopes />
    </QueryClientProvider>,
    () => run(() => current as ScopeProbe),
  );
}
