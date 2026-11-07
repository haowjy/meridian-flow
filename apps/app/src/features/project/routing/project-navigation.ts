/** One history policy for project destinations, secondary choices, and delayed address repair. */

import {
  type AddressSelection,
  type ProjectAddress,
  parseProjectAddress,
  projectAddressHref,
  projectAddressState,
} from "./project-address";
import { type AddressCatalog, guardProjectQuerySelections } from "./project-address-resolution";

export type ProjectHistoryEntry = { href: string; key: string; state: Record<string, unknown> };
export type ProjectNavigationPort = {
  read(): ProjectHistoryEntry;
  subscribe(listener: () => void): () => void;
  flush(): void;
  settlePendingTraversal(): undefined | Promise<boolean>;
  /** Synchronous same-entry snapshot or query repair; does not invoke a destination blocker. */
  replaceEntry(href: string, state: Record<string, unknown>): void;
  /** Dispatch after the shared leave decision; the adapter bypasses duplicate blockers. */
  navigate(
    href: string,
    options: { replace: boolean; state?: Record<string, unknown> },
  ): Promise<void>;
};
export type DisplayedProjectSelection = {
  work: AddressSelection;
  /** Existing local ownership pointer, never content or a new draft instance. */
  local?: { accountId: string; projectId: string; resourceHandle: string };
};
export type ProjectAddressReplacement =
  | { kind: "replaced" | "superseded" }
  | { kind: "failed"; error: unknown; ticket: ProjectNavigationTicket };
export type ProjectNavigationTicket = { revision: number; key: string; href: string };

export type NavigationSettlement =
  | { kind: "applied" | "cancelled" | "superseded" }
  | {
      kind: "failed";
      error: unknown;
      ticket: ProjectNavigationTicket;
      stage: "before-acceptance" | "workspace-commit";
    };
export type NavigationEffects = { afterCommit?: () => void };
export type PreparedWorkspaceNavigation = {
  isCurrent(): boolean;
  commit(): void;
  afterCommit?: () => void;
};
export type ProjectLeaveGuard = {
  request(intent: { run(): void; cancel(): void }): void;
  dirty(): boolean;
  cancel(): void;
};

/** Whether the entry already holds exactly this address, including its no-Work pin. */
function sameEntryAddress(entry: ProjectHistoryEntry, address: ProjectAddress): boolean {
  return (
    entry.href === projectAddressHref(address) &&
    JSON.stringify(entry.state.meridianProjectEmptySelection) ===
      JSON.stringify(projectAddressState(address).meridianProjectEmptySelection)
  );
}

export function createProjectNavigation(
  port: ProjectNavigationPort,
  displayed: () => DisplayedProjectSelection,
) {
  let revision = 0;
  let guard: ProjectLeaveGuard | null = null;
  let cancelDecision: (() => void) | null = null;
  let departureWrite = false;
  let pending: {
    id: string;
    commit?: () => void;
    finish(result: NavigationSettlement): void;
  } | null = null;
  const unsubscribe = port.subscribe(() => {
    revision += 1;
    if (departureWrite) return;
    cancelDecision?.();
    const operation = pending;
    if (!operation) return;
    if (port.read().state.meridianNavigationOperation !== operation.id) {
      operation.finish({ kind: "superseded" });
      return;
    }
    // Native history must agree with the workspace snapshot before either can be reloaded.
    try {
      port.flush();
    } catch (error) {
      operation.finish({ kind: "failed", error, ticket: capture(), stage: "before-acceptance" });
      return;
    }
    try {
      operation.commit?.();
      operation.finish({ kind: "applied" });
    } catch (error) {
      operation.finish({ kind: "failed", error, ticket: capture(), stage: "workspace-commit" });
    }
  });
  function claimIntent(restoreNative: boolean) {
    revision += 1;
    // Retire the old POP before cancelling its decision: its asynchronous
    // blocker callback must not cancel the replacement writer intent.
    const restoration = restoreNative ? port.settlePendingTraversal() : undefined;
    cancelDecision?.();
    pending?.finish({ kind: "superseded" });
    return { ticket: capture(), restoration };
  }
  function beginIntent(): ProjectNavigationTicket {
    return claimIntent(true).ticket;
  }
  function requestLeave(run: () => void, cancel: () => void): void {
    let active = true;
    const settle = (callback: () => void) => {
      if (!active) return;
      active = false;
      cancelDecision = null;
      callback();
    };
    const owner = guard;
    cancelDecision = () =>
      settle(() => {
        owner?.cancel();
        cancel();
      });
    if (guard) guard.request({ run: () => settle(run), cancel: () => settle(cancel) });
    else settle(run);
  }
  const capture = (): ProjectNavigationTicket => {
    const entry = port.read();
    return { revision, key: entry.key, href: entry.href };
  };
  function isCurrent(ticket: ProjectNavigationTicket): boolean {
    const entry = port.read();
    return revision === ticket.revision && entry.key === ticket.key && entry.href === ticket.href;
  }

  function parsedEntry(entry: ProjectHistoryEntry) {
    const href = entry.href.split("#", 1)[0];
    const cut = href.indexOf("?");
    return parseProjectAddress(
      cut < 0 ? href : href.slice(0, cut),
      cut < 0 ? "" : href.slice(cut),
      entry.state,
    );
  }

  function freezeDeparture(): void {
    const entry = port.read();
    const parsed = parsedEntry(entry);
    if (parsed.kind !== "valid") return;
    const current = parsed.address;
    const shown = displayed();
    const frozen: ProjectAddress = {
      ...current,
      work: current.work.kind === "absent" ? shown.work : current.work,
    };
    const href = projectAddressHref(frozen);
    port.replaceEntry(
      href,
      projectAddressState(frozen, {
        ...entry.state,
        meridianProjectSelection: shown.local ? { version: 2, ...shown.local } : undefined,
      }),
    );
  }

  function transition(
    address: ProjectAddress,
    options: { replace: boolean; state?: Record<string, unknown> },
    prepared?: PreparedWorkspaceNavigation,
  ): Promise<NavigationSettlement> {
    let intent: ReturnType<typeof claimIntent>;
    try {
      intent = claimIntent(true);
    } catch (error) {
      return Promise.resolve({
        kind: "failed",
        error,
        ticket: capture(),
        stage: "before-acceptance",
      });
    }
    const { ticket, restoration } = intent;
    const requestedRevision = ticket.revision;
    return new Promise((resolve) => {
      const dispatch = () => {
        try {
          if (revision !== requestedRevision || prepared?.isCurrent() === false) {
            resolve({ kind: "superseded" });
            return;
          }
          const current = parsedEntry(port.read());
          const next =
            current.kind === "valid" && !address.settings
              ? { ...address, settings: current.address.settings }
              : address;
          // A replacement of the entry by itself: another writer (address admission following a
          // rename) already put this address there. Writing it again only repeats the history
          // write, so the destination is reached without one.
          if (options.replace && !options.state && sameEntryAddress(port.read(), next)) {
            try {
              prepared?.commit();
              prepared?.afterCommit?.();
            } catch (error) {
              resolve({ kind: "failed", error, ticket: capture(), stage: "workspace-commit" });
              return;
            }
            resolve({ kind: "applied" });
            return;
          }
          if (!options.replace) {
            departureWrite = true;
            try {
              freezeDeparture();
              port.flush();
            } finally {
              departureWrite = false;
            }
          }
          const id = crypto.randomUUID();
          const operation = {
            id,
            commit: () => {
              prepared?.commit();
              prepared?.afterCommit?.();
            },
            finish(result: NavigationSettlement) {
              if (pending !== operation) return;
              pending = null;
              resolve(result);
            },
          };
          pending = operation;
          void port
            .navigate(projectAddressHref(next), {
              ...options,
              state: {
                ...projectAddressState(next, options.state),
                meridianNavigationOperation: id,
              },
            })
            .catch((error) =>
              operation.finish({
                kind: "failed",
                error,
                ticket: capture(),
                stage: "before-acceptance",
              }),
            );
        } catch (error) {
          pending?.finish({ kind: "failed", error, ticket: capture(), stage: "before-acceptance" });
          resolve({ kind: "failed", error, ticket: capture(), stage: "before-acceptance" });
        }
      };
      try {
        requestLeave(
          () => {
            try {
              if (restoration) {
                void restoration.then(
                  (restored) => (restored ? dispatch() : resolve({ kind: "superseded" })),
                  (error) =>
                    resolve({
                      kind: "failed",
                      error,
                      ticket: capture(),
                      stage: "before-acceptance",
                    }),
                );
              } else dispatch();
            } catch (error) {
              resolve({ kind: "failed", error, ticket: capture(), stage: "before-acceptance" });
            }
          },
          () => resolve({ kind: revision === requestedRevision ? "cancelled" : "superseded" }),
        );
      } catch (error) {
        resolve({ kind: "failed", error, ticket: capture(), stage: "before-acceptance" });
      }
    });
  }

  return {
    capture,
    beginIntent,
    transition,
    registerGuard(next: ProjectLeaveGuard) {
      guard = next;
      return () => {
        if (guard !== next) return;
        guard = null;
        cancelDecision?.();
      };
    },
    hasUnsavedChanges: () => guard?.dirty() ?? false,
    allowDeparture(): Promise<boolean> {
      claimIntent(false);
      return new Promise((resolve) =>
        requestLeave(
          () => resolve(true),
          () => resolve(false),
        ),
      );
    },
    captureForEntry(entryKey: string): ProjectNavigationTicket | null {
      const ticket = capture();
      return ticket.key === entryKey ? ticket : null;
    },
    isCurrent,
    navigate(
      address: ProjectAddress,
      options: { replace: boolean; state?: Record<string, unknown> } & NavigationEffects,
    ) {
      return transition(address, options, {
        isCurrent: () => true,
        commit: () => undefined,
        afterCommit: options.afterCommit,
      });
    },
    /** Rewrites the current entry in place: canonical path (bare project → `/chats`) and invalid `?work=`. */
    repairAddress(
      ticket: ProjectNavigationTicket,
      catalogs: {
        work: AddressCatalog<{ id: string }>;
      },
    ): void {
      if (!isCurrent(ticket)) return;
      const entry = port.read();
      const parsed = parsedEntry(entry);
      if (parsed.kind !== "valid") return;
      const next = guardProjectQuerySelections(parsed.address, catalogs);
      const pathOf = (href: string) => href.split(/[?#]/, 1)[0];
      if (next === parsed.address && pathOf(parsed.href) === pathOf(entry.href)) return;
      // The destination does not change. Do not queue a destination blocker
      // that could later compete with the writer's pending navigation.
      revision += 1;
      port.replaceEntry(projectAddressHref(next), projectAddressState(next, entry.state));
    },
    async replaceIfCurrent(
      ticket: ProjectNavigationTicket,
      address: ProjectAddress,
    ): Promise<ProjectAddressReplacement> {
      // Address ownership effects may race a writer's destination command. A
      // delayed repair must never retire that command or ask its leave guard.
      if (!isCurrent(ticket) || pending || cancelDecision) return { kind: "superseded" };
      const entry = port.read();
      if (sameEntryAddress(entry, address)) return { kind: "replaced" };
      try {
        port.replaceEntry(projectAddressHref(address), projectAddressState(address, entry.state));
        return { kind: "replaced" };
      } catch (error) {
        return { kind: "failed", error, ticket: capture() };
      }
    },
    dispose() {
      claimIntent(false);
      guard = null;
      unsubscribe();
    },
  };
}
