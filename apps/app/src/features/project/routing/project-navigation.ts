/** One history policy for project destinations, secondary choices, and delayed address repair. */
import { type ProjectAddress, parseProjectAddress, projectAddressHref } from "./project-address";

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
    return parseProjectAddress(cut < 0 ? href : href.slice(0, cut), cut < 0 ? "" : href.slice(cut));
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
    if (href === entry.href && !shown.local && !entry.state.meridianProjectSelection) return;
    port.replaceEntry(href, {
      ...entry.state,
      meridianProjectSelection: shown.local ? { version: 1, ...shown.local } : undefined,
    });
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
      // Invalidate an in-flight default even when a blocker delays the ensuing push.
      revision += 1;
      const current = parsedEntry(port.read());
      const next =
        current.kind === "valid" && !address.settings
          ? { ...address, settings: current.address.settings }
          : address;
      if (!options.replace) freezeDeparture();
      return port.navigate(projectAddressHref(next), options);
    },
    async replaceIfCurrent(
      ticket: ProjectNavigationTicket,
      address: ProjectAddress,
    ): Promise<boolean> {
      if (!isCurrent(ticket)) return false;
      revision += 1;
      await port.navigate(projectAddressHref(address), { replace: true, state: port.read().state });
      return true;
    },
    dispose: unsubscribe,
  };
}
