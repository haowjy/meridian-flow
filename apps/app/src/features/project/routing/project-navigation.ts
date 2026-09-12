/** One history policy for project destinations, secondary choices, and delayed address repair. */
import {
  type ProjectAddress,
  parseProjectAddress,
  projectAddressHref,
  projectAddressState,
} from "./project-address";

export type ProjectHistoryEntry = { href: string; key: string; state: Record<string, unknown> };
export type ProjectNavigationPort = {
  read(): ProjectHistoryEntry;
  subscribe(listener: () => void): () => void;
  /** Synchronous departure snapshot; does not invoke a destination blocker. */
  replaceEntry(href: string, state: Record<string, unknown>): void;
  /** The router owns destination blockers and load/error presentation. */
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

export function createProjectNavigation(
  port: ProjectNavigationPort,
  displayed: () => DisplayedProjectSelection,
) {
  let revision = 0;
  const unsubscribe = port.subscribe(() => {
    revision += 1;
  });
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

  return {
    capture,
    captureForEntry(expected: { key: string; href: string }): ProjectNavigationTicket | null {
      const ticket = capture();
      return ticket.key === expected.key && ticket.href === expected.href ? ticket : null;
    },
    isCurrent,
    async navigate(
      address: ProjectAddress,
      options: { replace: boolean; state?: Record<string, unknown> },
    ) {
      // Invalidate older address repairs even when a blocker delays the ensuing push.
      revision += 1;
      const current = parsedEntry(port.read());
      const next =
        current.kind === "valid" && !address.settings
          ? { ...address, settings: current.address.settings }
          : address;
      if (!options.replace) freezeDeparture();
      return port.navigate(projectAddressHref(next), {
        ...options,
        state: projectAddressState(next, options.state),
      });
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
      const replacementRevision = ++revision;
      try {
        await port.navigate(href, { replace: true, state });
        return { kind: "replaced" };
      } catch {
        const current = port.read();
        // The initiating ticket was retired by this replacement, not necessarily by another intent.
        return revision === replacementRevision &&
          current.key === entry.key &&
          current.href === entry.href
          ? {
              kind: "failed",
              ticket: { revision: replacementRevision, key: entry.key, href: entry.href },
            }
          : { kind: "superseded" };
      }
    },
    dispose: unsubscribe,
  };
}
