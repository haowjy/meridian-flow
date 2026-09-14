/** One history policy for project destinations, secondary choices, and delayed address repair. */
import {
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
  chatSlug: string | null;
  workSlug: string | null;
  /** Existing local ownership pointer, never content or a new draft instance. */
  local?: { accountId: string; projectId: string; threadId?: string; documentId?: string };
};
export type ProjectAddressReplacement =
  | { kind: "replaced" | "superseded" }
  | { kind: "failed"; ticket: ProjectNavigationTicket };
export type ProjectNavigationTicket = { revision: number; key: string; href: string };

export type NavigationSettlement =
  | { kind: "applied" | "cancelled" | "superseded" }
  | { kind: "failed"; error: unknown; ticket: ProjectNavigationTicket };
export type PreparedWorkspaceNavigation = {
  isCurrent(): boolean;
  commit(): void;
};
export type ProjectLeaveGuard = {
  request(intent: { run(): void; cancel(): void }): void;
  dirty(): boolean;
  cancel(): void;
};

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
      operation.commit?.();
      operation.finish({ kind: "applied" });
    } catch (error) {
      operation.finish({ kind: "failed", error, ticket: capture() });
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
      chat:
        current.chat.kind === "absent"
          ? shown.chatSlug
            ? { kind: "slug", slug: shown.chatSlug }
            : { kind: "none" }
          : current.chat,
      work:
        current.work.kind === "absent"
          ? shown.workSlug
            ? { kind: "slug", slug: shown.workSlug }
            : { kind: "none" }
          : current.work,
    };
    const href = projectAddressHref(frozen);
    port.replaceEntry(
      href,
      projectAddressState(frozen, {
        ...entry.state,
        meridianProjectSelection: shown.local ? { version: 1, ...shown.local } : undefined,
      }),
    );
  }

  function transition(
    address: ProjectAddress,
    options: { replace: boolean; state?: Record<string, unknown> },
    prepared?: PreparedWorkspaceNavigation,
  ): Promise<NavigationSettlement> {
    const { ticket, restoration } = claimIntent(true);
    const requestedRevision = ticket.revision;
    return new Promise((resolve) => {
      const dispatch = () => {
        if (revision !== requestedRevision || prepared?.isCurrent() === false) {
          resolve({ kind: "superseded" });
          return;
        }
        const current = parsedEntry(port.read());
        const next =
          current.kind === "valid" && !address.settings
            ? { ...address, settings: current.address.settings }
            : address;
        try {
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
            commit: prepared?.commit,
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
            .catch((error) => operation.finish({ kind: "failed", error, ticket: capture() }));
        } catch (error) {
          pending?.finish({ kind: "failed", error, ticket: capture() });
          resolve({ kind: "failed", error, ticket: capture() });
        }
      };
      requestLeave(
        () => {
          try {
            if (restoration) {
              void restoration.then(
                (restored) => (restored ? dispatch() : resolve({ kind: "superseded" })),
                (error) => resolve({ kind: "failed", error, ticket: capture() }),
              );
            } else dispatch();
          } catch (error) {
            resolve({ kind: "failed", error, ticket: capture() });
          }
        },
        () => resolve({ kind: revision === requestedRevision ? "cancelled" : "superseded" }),
      );
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
    async navigate(
      address: ProjectAddress,
      options: { replace: boolean; state?: Record<string, unknown> },
    ) {
      const result = await transition(address, options);
      if (result.kind === "failed") throw result.error;
    },
    repairQuerySelections(
      ticket: ProjectNavigationTicket,
      catalogs: {
        chat: AddressCatalog<{ slug: string | null }>;
        work: AddressCatalog<{ slug: string | null }>;
      },
    ): void {
      if (!isCurrent(ticket)) return;
      const entry = port.read();
      const parsed = parsedEntry(entry);
      if (parsed.kind !== "valid") return;
      const next = guardProjectQuerySelections(parsed.address, catalogs);
      if (next === parsed.address) return;
      // Only invalid secondary selections change. Do not queue a destination
      // blocker that could later compete with the writer's pending navigation.
      revision += 1;
      port.replaceEntry(projectAddressHref(next), projectAddressState(next, entry.state));
    },
    async replaceIfCurrent(
      ticket: ProjectNavigationTicket,
      address: ProjectAddress,
    ): Promise<ProjectAddressReplacement> {
      if (!isCurrent(ticket)) return { kind: "superseded" };
      const entry = port.read();
      const href = projectAddressHref(address);
      const state = projectAddressState(address, entry.state);
      if (
        href === entry.href &&
        JSON.stringify(state.meridianProjectEmptySelection) ===
          JSON.stringify(entry.state.meridianProjectEmptySelection)
      )
        return { kind: "replaced" };
      const result = await transition(address, { replace: true, state });
      if (result.kind === "applied") return { kind: "replaced" };
      if (result.kind === "failed") return { kind: "failed", ticket: result.ticket };
      return { kind: "superseded" };
    },
    dispose() {
      claimIntent(false);
      guard = null;
      unsubscribe();
    },
  };
}
