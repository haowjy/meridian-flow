/** Real review scopes and instance-owned network/account seams for composed app tests. */

import type { Work } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, useState } from "react";
import { vi } from "vitest";
import * as draftsApi from "@/client/api/drafts-api";
import { useWorkDrafts } from "@/client/query/useWorkDrafts";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { DocumentSession } from "@/core/editor/document-session";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { DraftOnlyTabSettlement } from "@/features/draft-review/DraftOnlyTabSettlement";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
  EditorReviewScope,
  useDraftReview,
  useDraftReviewScopeValue,
} from "@/features/draft-review/DraftReviewProvider";
import type { DraftChangesView } from "@/features/draft-review/draft-changes";
import { type DraftChangesTarget, useDraftChanges } from "@/features/draft-review/useDraftChanges";
import { type ReviewChangesView, useReviewChanges } from "@/features/draft-review/useReviewChanges";
import { type ReviewHeaderModel, useReviewHeader } from "@/features/draft-review/useReviewHeader";
import {
  useWorkDraftCommands,
  type WorkDraftCommands,
  WorkDraftCommandsBoundary,
} from "@/features/draft-review/useWorkDraftCommands";
import * as account from "@/features/project/context/account-feature-context";
import { ContextRemovalCoordinator } from "@/features/project/context/context-removal-coordinator";
import { withReactRoot } from "./react-dom-harness";

export const work = {
  id: "work-a",
  projectId: "project-a",
  name: "Work A",
  archivedAt: null,
} as Work;

/** A Work neither the Editor nor the Chat has: an independent Work command capability. */
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
  contextPath: null,
  status: "active" as const,
  draftGeneration: 1,
  actorThreads: [],
  updatedAt: "2026-10-07T00:00:00.000Z",
};

export const operation = (id: string) => ({
  operationId: id,
  closureClassId: `class-${id}`,
  kind: "agent" as const,
  classification: "addition" as const,
});

export const preview = {
  status: "active" as const,
  draftId: "draft-a",
  draftGeneration: 1,
  inlineModelPresent: true as const,
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
  status: "applied" as const,
  draftId: "draft-a",
  operationIds: [id],
  closureClassIds: [`class-${id}`],
  draftClosed,
});

export const discarded = (draftClosed: boolean) => ({
  status: "discarded" as const,
  draftId: "draft-a",
  draftClosed,
});

export type ScopeProbe = {
  queryClient: QueryClient;
  editor: DraftReviewContextValue;
  chat: { commands: WorkDraftCommands; files: ReviewFileTarget[] };
  third: { commands: WorkDraftCommands; files: ReviewFileTarget[] };
  header: ReviewHeaderModel;
  openDraft: (draft: ReviewedDraft) => Promise<void>;
  mountLateReader: () => Promise<() => ReviewChangesView>;
  chatRunner: WorkDraftCommands;
  moveEditorToWork: (to: Work) => Promise<void>;
  moveChatToWork: (to: Work) => Promise<void>;
  mountDraftChanges: (
    target: DraftChangesTarget,
    scope?: "chat" | "third",
  ) => Promise<() => DraftChangesView>;
};

export type ReviewedDraft = { documentId: string; draftId: string };

export async function renderReviewScopes(
  run: (probe: () => ScopeProbe) => Promise<void>,
  options: {
    reviewed?: ReviewedDraft;
    projectId?: string;
    editorWork?: Work;
    chatWork?: Work;
    thirdWork?: Work;
    threadId?: string;
    host?: (children: ReactNode) => ReactNode;
    onOpenDraft?: (row: ReviewFileTarget) => void;
    /** A surface that reads the scopes, as the project shell offers them (the Work page's list). */
    surface?: ReactNode;
    /** A surface that lives in the Chat's scope (the composer strip), beside the Editor's. */
    chatSurface?: ReactNode;
  } = {},
): Promise<void> {
  const {
    reviewed: initialReviewed = { documentId: "document-a", draftId: "draft-a" },
    onOpenDraft = () => {},
    surface = null,
    chatSurface = null,
  } = options;
  const current: Partial<ScopeProbe> = {};
  let lateView: ReviewChangesView | null = null;
  let showLateReader: (() => void) | null = null;
  let addChangeList: ((target: DraftChangesTarget, scope: "chat" | "third") => void) | null = null;
  const changeLists = new Map<DraftChangesTarget, DraftChangesView>();
  function ChangeList({ target, scope }: { target: DraftChangesTarget; scope: "chat" | "third" }) {
    const controller = current[scope]?.commands as WorkDraftCommands;
    changeLists.set(target, useDraftChanges(target, { controller }));
    return null;
  }
  function RunnerProbe() {
    current.chatRunner = current.chat?.commands as WorkDraftCommands;
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
        {surface}
      </>
    );
  }
  function Scopes(): ReactNode {
    const [editorWork, setEditorWork] = useState(options.editorWork ?? work);
    current.moveEditorToWork = (to) => act(async () => setEditorWork(to));
    const editor = useDraftReviewScopeValue({
      projectId: options.projectId ?? "project-a",
      work: editorWork,
    });
    const [chatWork, setChatWork] = useState(options.chatWork ?? work);
    current.moveChatToWork = (to) => act(async () => setChatWork(to));
    const chatCommands = useWorkDraftCommands({
      projectId: options.projectId ?? "project-a",
      work: chatWork,
      threadId: options.threadId ?? "thread-a",
    });
    const thirdCommands = useWorkDraftCommands({
      projectId: options.projectId ?? "project-a",
      work: options.thirdWork ?? workC,
    });
    current.editor = editor;
    const chat = {
      commands: chatCommands,
      files: useWorkDrafts(options.projectId ?? "project-a", chatWork.id).files ?? [],
    };
    current.chat = chat;
    const third = {
      commands: thirdCommands,
      files:
        useWorkDrafts(options.projectId ?? "project-a", (options.thirdWork ?? workC).id).files ??
        [],
    };
    current.third = third;
    return (
      <EditorReviewScope value={editor}>
        <DraftOnlyTabSettlement projectId={options.projectId ?? "project-a"} />
        <DraftReviewBoundary value={editor}>
          <HeaderProbe />
        </DraftReviewBoundary>
        {chatSurface ? (
          <WorkDraftCommandsBoundary value={chat.commands}>{chatSurface}</WorkDraftCommandsBoundary>
        ) : null}
      </EditorReviewScope>
    );
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  current.queryClient = queryClient;
  const node = (
    <QueryClientProvider client={queryClient}>
      {options.host ? options.host(<Scopes />) : <Scopes />}
    </QueryClientProvider>
  );
  try {
    await withReactRoot(node, () => run(() => current as ScopeProbe), {
      drainMacrotask: !vi.isFakeTimers(),
    });
  } finally {
    queryClient.clear();
  }
}

/** One answer per held request; resolve/reject inside act, independently of other requests. */
export function deferredReviewAnswer<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Install only for this test; dispose after unmount. No import-time replacement of modules. */
export function createReviewScopeFixture(
  options: {
    removal?: ContextRemovalCoordinator;
    registry?: LiveDocumentSessionRegistry;
    resources?: ReturnType<typeof account.useOptionalAccountResourceReplica>;
  } = {},
) {
  const network = {
    listWorkDrafts: vi.spyOn(draftsApi, "listWorkDrafts"),
    getDraftPreview: vi.spyOn(draftsApi, "getDraftPreview"),
    applyDraft: vi.spyOn(draftsApi, "applyDraft"),
    applyDraftChanges: vi.spyOn(draftsApi, "applyDraftChanges"),
    discardDraft: vi.spyOn(draftsApi, "discardDraft"),
  };
  // Unconfigured requests stay pending, never accidentally reach a real server.
  for (const endpoint of Object.values(network))
    endpoint.mockReturnValue(new Promise<never>(() => {}));
  const removal = options.removal ?? new ContextRemovalCoordinator();
  const rooms = new Map<string, DocumentSession>();
  // Detached sessions supply subscription truth without claiming a wire/paint witness.
  const registry =
    options.registry ??
    ({
      retainBranchRooms: () => {},
      releaseBranchRooms: () => {},
      getBranchRoom: (roomKey: string) => {
        let room = rooms.get(roomKey);
        if (!room) {
          room = new DocumentSession({ roomKey, persistence: { kind: "none" } });
          rooms.set(roomKey, room);
        }
        return room;
      },
    } as unknown as LiveDocumentSessionRegistry);
  const seams = [
    vi.spyOn(account, "useContextRemovalCoordinator").mockReturnValue(removal),
    vi.spyOn(account, "useLiveDocumentSessionRegistry").mockReturnValue(registry),
    vi
      .spyOn(account, "useOptionalAccountResourceReplica")
      .mockReturnValue(options.resources ?? null),
  ];
  return {
    network,
    removal,
    render: renderReviewScopes,
    dispose() {
      for (const spy of [...Object.values(network), ...seams]) spy.mockRestore();
      if (!options.removal) removal.dispose();
      for (const room of rooms.values()) room.destroy();
    },
  };
}
