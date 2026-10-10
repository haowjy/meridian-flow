/** Browser-tab-local, account-stamped document slot for the project dock. */
import { create } from "zustand";
import type { ContextTab } from "@/client/stores";
import type { ReviewAddress } from "../presented-document";
import type { ScreenKey } from "../shell/screens";
import {
  browserDockStorage,
  type DockStorage,
  readDockSnapshot,
  writeDockSnapshot,
} from "./dock-persistence";

/**
 * The one document the dock shows in place of its views, until the writer
 * closes it. Work documents also close on leaving their Work screen. Its
 * project prevents a document appearing in another project. On the Editor
 * screen documents open as tabs instead; a Chat document can stay parked.
 */
export type DockDocument = {
  projectId: string;
  screen: Exclude<ScreenKey, "context">;
  tab: ContextTab;
  review: ReviewAddress | null;
};

type DockScope = { projectId: string; screen: ScreenKey; workId: string | null };

/** Chat documents can stay parked; a Work's note belongs only to that Work's screen. */
export function dockDocumentFitsScope(
  document: DockDocument | null,
  scope: DockScope | null,
): boolean {
  if (!document) return false;
  if (!scope) return true;
  return (
    document.projectId === scope.projectId &&
    (document.screen !== "work" ||
      (scope.screen === "work" &&
        document.tab.kind !== "new" &&
        document.tab.workId === scope.workId))
  );
}

type DockDocumentState = {
  accountId: string | null;
  /** Restore once per authenticated account; a foreign account's layout is never admitted. */
  rehydrate: (accountId: string) => void;
  occupant: DockDocument | null;
  /** Hidden until resource validation finishes; every writer intent cancels restoration. */
  restoring: DockDocument | null;
  restore: (expected: DockDocument, document: DockDocument | null) => void;
  /**
   * Bumps on every new intent: an open requested or made, a close, a native reveal, and a move to another project, screen or Work. A slow open claims
   * a revision when it starts and commits only if it is still the latest.
   */
  revision: number;
  /** Where the writer is, as last synced; only a real change counts as an intent. */
  scope: DockScope | null;
  /** The Work on the Work screen (null elsewhere): the Work whose Scratch the dock menu browses. */
  workId: string | null;
  clearDocumentOn: (screen: ScreenKey) => void;
  /** Address updates and remote settlement are not writer intents. */
  setDocumentReview: (review: ReviewAddress | null) => void;
  /** Start an open: bumps the revision and returns it. Every async dock attempt claims first. */
  claim: () => number;
  /** Whether `claim` is still the latest intent. */
  isCurrent: (claim: number) => boolean;
  /** Show the document if `claim` is still the latest intent; false means it was superseded. */
  commit: (claim: number, document: DockDocument) => boolean;
  closeDocument: () => void;
  /** Fence project changes and departures from a Work; Chat documents can stay parked. */
  syncOccupantScope: (projectId: string, screen: ScreenKey, workId: string | null) => void;
};

export function createDockDocumentStore(
  storage: () => DockStorage | null = browserDockStorage,
  accountId: string | null = null,
) {
  const snapshot = readDockSnapshot(storage, accountId);
  const store = create<DockDocumentState>((set, get) => {
    const setOccupant = (occupant: DockDocument | null) =>
      set((state) => ({ occupant, restoring: null, revision: state.revision + 1 }));
    return {
      accountId,
      rehydrate: (accountId) => {
        const state = get();
        if (state.accountId === accountId) return;
        const snapshot = readDockSnapshot(storage, accountId);
        set({
          accountId,
          occupant: null,
          restoring: dockDocumentFitsScope(snapshot?.occupant ?? null, state.scope)
            ? (snapshot?.occupant ?? null)
            : null,
          // Account changes invalidate outstanding claims, not just the restore candidate.
          revision: state.revision + (state.accountId === null ? 0 : 1),
        });
      },
      occupant: null,
      restoring: snapshot?.occupant ?? null,
      restore: (expected, document) => {
        if (get().restoring !== expected) return;
        // A restore is not a new intent and must never supersede a writer's claim.
        set({
          restoring: null,
          occupant: dockDocumentFitsScope(document, get().scope) ? document : null,
        });
      },
      revision: 0,
      scope: null,
      workId: null,
      clearDocumentOn: (screen) =>
        set((state) => ({
          restoring: null,
          occupant: state.occupant?.screen === screen ? null : state.occupant,
          revision: state.revision + 1,
        })),
      setDocumentReview: (review) =>
        set((state) => {
          const document = state.occupant;
          if (!document || (document.tab.kind === "tracked" && document.tab.draftOnly && !review))
            return state;
          if (
            document.review?.workId === review?.workId &&
            document.review?.draftId === review?.draftId
          )
            return state;
          return { occupant: { ...document, review } };
        }),
      isCurrent: (claim) => get().revision === claim,
      commit: (claim, document) => {
        if (get().revision !== claim) return false;
        setOccupant(document);
        return true;
      },
      claim: () => {
        set((state) => ({ restoring: null, revision: state.revision + 1 }));
        return get().revision;
      },
      closeDocument: () => setOccupant(null),
      syncOccupantScope: (projectId, screen, workId) =>
        set((state) => {
          const scope = { projectId, screen, workId };
          if (
            state.scope?.projectId === projectId &&
            state.scope.screen === screen &&
            state.scope.workId === workId
          )
            return state;
          const stays = dockDocumentFitsScope(state.occupant ?? state.restoring, scope);
          return {
            scope,
            workId: screen === "work" ? workId : null,
            occupant: stays ? state.occupant : null,
            restoring: stays ? state.restoring : null,
            revision: state.revision + 1,
          };
        }),
    };
  });
  store.subscribe((state, previous) => {
    if (!state.accountId) return;
    if (
      state.accountId === previous.accountId &&
      state.occupant === previous.occupant &&
      state.restoring === previous.restoring
    )
      return;
    writeDockSnapshot(storage, {
      accountId: state.accountId,
      occupant: state.occupant ?? state.restoring,
    });
  });
  return store;
}

export const useDockDocumentStore = createDockDocumentStore();

/** One scope predicate for rendering, highlighting and imperative hand-offs. */
export function dockDocumentOnScreen(
  occupant: DockDocument | null,
  screen: ScreenKey,
  projectId: string,
): DockDocument | null {
  return occupant?.screen === screen && occupant.projectId === projectId ? occupant : null;
}

export function useDockDocument(screen: ScreenKey, projectId: string): DockDocument | null {
  return useDockDocumentStore((state) => dockDocumentOnScreen(state.occupant, screen, projectId));
}

/** Overlay identity is intrinsic; callers cannot carry a draft-only tab as live. */
export function dockDocument(
  projectId: string,
  screen: DockDocument["screen"],
  tab: ContextTab,
  review: ReviewAddress | null,
): DockDocument {
  const intrinsic =
    tab.kind === "tracked" && tab.draftOnly && tab.reviewWorkId && tab.reviewDraftId
      ? { workId: tab.reviewWorkId, draftId: tab.reviewDraftId }
      : review;
  return { projectId, screen, tab, review: intrinsic };
}
