/** Browser-tab-local view choices and the document slot for the project dock. */
import { create } from "zustand";
import type { ContextTab } from "@/client/stores";
import type { ScreenKey } from "../shell/screens";
import {
  browserDockStorage,
  type DockStorage,
  readDockSnapshot,
  writeDockSnapshot,
} from "./dock-persistence";
import { type DockView, type ResolvedDockView, resolveDockView } from "./dock-views";

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

type DockViewState = {
  accountId: string | null;
  /** Restore once per authenticated account; a foreign account's layout is never admitted. */
  rehydrate: (accountId: string) => void;
  byScreen: Partial<Record<ScreenKey, DockView>>;
  occupant: DockDocument | null;
  /** Hidden until resource validation finishes; every writer intent cancels restoration. */
  restoring: DockDocument | null;
  restore: (expected: DockDocument, tab: ContextTab | null) => void;
  /**
   * Bumps on every new intent: an open requested or made, a close, a view
   * choice, and a move to another project, screen or Work. A slow open claims
   * a revision when it starts and commits only if it is still the latest.
   */
  revision: number;
  /** Where the writer is, as last synced; only a real change counts as an intent. */
  scope: DockScope | null;
  /** The Work on the Work screen (null elsewhere): the Work whose Scratch the dock menu browses. */
  workId: string | null;
  /** The writer picks a view: it replaces an occupant the dock was showing on that screen. */
  setDockView: (screen: ScreenKey, view: DockView) => void;
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

export function createDockViewStore(
  storage: () => DockStorage | null = browserDockStorage,
  accountId: string | null = null,
) {
  const snapshot = readDockSnapshot(storage, accountId);
  const store = create<DockViewState>((set, get) => {
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
          byScreen: snapshot?.byScreen ?? {},
          occupant: null,
          restoring: dockDocumentFitsScope(snapshot?.occupant ?? null, state.scope)
            ? (snapshot?.occupant ?? null)
            : null,
          // Account changes invalidate outstanding claims, not just the restore candidate.
          revision: state.revision + (state.accountId === null ? 0 : 1),
        });
      },
      byScreen: snapshot?.byScreen ?? {},
      occupant: null,
      restoring: snapshot?.occupant ?? null,
      restore: (expected, tab) => {
        if (get().restoring !== expected) return;
        // A restore is not a new intent and must never supersede a writer's claim.
        const document = tab ? { ...expected, tab } : null;
        set({
          restoring: null,
          occupant: dockDocumentFitsScope(document, get().scope) ? document : null,
        });
      },
      revision: 0,
      scope: null,
      workId: null,
      setDockView: (screen, view) =>
        set((state) => ({
          byScreen: { ...state.byScreen, [screen]: view },
          restoring: null,
          occupant: state.occupant?.screen === screen ? null : state.occupant,
          revision: state.revision + 1,
        })),
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
      state.restoring === previous.restoring &&
      state.byScreen === previous.byScreen
    )
      return;
    writeDockSnapshot(storage, {
      accountId: state.accountId,
      byScreen: state.byScreen,
      occupant: state.occupant ?? state.restoring,
    });
  });
  return store;
}

export const useDockViewStore = createDockViewStore();

/** Resolve the active dock view for a screen and bind the switch action. */
export function useDockView(
  screen: ScreenKey,
  projectId: string,
): ResolvedDockView & {
  setView: (view: DockView) => void;
  /** The document replacing the views on this screen, if any. */
  document: DockDocument | null;
} {
  const stored = useDockViewStore((state) => state.byScreen[screen]);
  const setDockView = useDockViewStore((state) => state.setDockView);
  const occupant = useDockDocument(screen, projectId);
  return {
    ...resolveDockView(screen, stored),
    setView: (next) => setDockView(screen, next),
    document: occupant,
  };
}

/** One scope predicate for rendering, highlighting and imperative hand-offs. */
export function dockDocumentOnScreen(
  occupant: DockDocument | null,
  screen: ScreenKey,
  projectId: string,
): DockDocument | null {
  return occupant?.screen === screen && occupant.projectId === projectId ? occupant : null;
}

export function useDockDocument(screen: ScreenKey, projectId: string): DockDocument | null {
  return useDockViewStore((state) => dockDocumentOnScreen(state.occupant, screen, projectId));
}
