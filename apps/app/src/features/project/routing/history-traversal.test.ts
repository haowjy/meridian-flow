// @vitest-environment jsdom
/** Conformance tests for the patched native-history restoration boundary. */
import { createBrowserHistory } from "@tanstack/react-router";
import { expect, it, vi } from "vitest";
import { createProjectNavigation } from "./project-navigation";

function fixture() {
  window.history.replaceState({}, "", "/");
  const history = createBrowserHistory({ window });
  history.replace("/source");
  history.flush();
  history.push("/displayed");
  history.flush();
  return history;
}

function popped() {
  return new Promise<void>((resolve) => {
    window.addEventListener("popstate", () => resolve(), { once: true });
  });
}

it("restores once before a new push and ignores the older blocker decision", async () => {
  const history = fixture();
  let decide!: (blocked: boolean) => void;
  const unblock = history.block({
    blockerFn: () =>
      new Promise<boolean>((resolve) => {
        decide = resolve;
      }),
  });
  const go = vi.spyOn(window.history, "go");
  try {
    const back = popped();
    history.back();
    await back;
    expect(window.location.pathname).toBe("/source");
    const restoration = history.settlePendingTraversal();
    expect(history.settlePendingTraversal()).toBe(restoration);
    await expect(restoration).resolves.toBe(true);
    expect(go).toHaveBeenCalledExactlyOnceWith(1);
    history.push("/new", undefined, { ignoreBlocker: true });
    history.flush();
    decide(true);
    await Promise.resolve();
    expect(window.location.pathname).toBe("/new");
    expect(history.location.pathname).toBe("/new");
    expect(go).toHaveBeenCalledOnce();
    unblock();
    const previous = popped();
    history.back();
    await previous;
    expect(window.location.pathname).toBe("/displayed");
  } finally {
    go.mockRestore();
    history.destroy();
  }
});

it("settles a waiting restoration on destruction instead of leaving its caller pending", async () => {
  const history = fixture();
  const unblock = history.block({ blockerFn: () => new Promise<boolean>(() => undefined) });
  const back = popped();
  history.back();
  await back;
  const restored = popped();
  const restoration = history.settlePendingTraversal();
  history.destroy();
  await expect(restoration).resolves.toBe(false);
  await restored;
  unblock();
});

it("keeps the replacement dirty decision while the old native POP restores", async () => {
  const history = fixture();
  const navigation = createProjectNavigation(
    {
      read: () => ({
        href: history.location.href,
        key: history.location.state.__TSR_key ?? "",
        state: { ...history.location.state },
      }),
      subscribe: (listener) => history.subscribe(listener),
      flush: () => history.flush(),
      settlePendingTraversal: () => history.settlePendingTraversal(),
      replaceEntry: (href, state) => history.replace(href, state, { ignoreBlocker: true }),
      navigate: async (href, options) => {
        if (options.replace) history.replace(href, options.state, { ignoreBlocker: true });
        else history.push(href, options.state, { ignoreBlocker: true });
      },
    },
    () => ({ chatId: null, workSlug: null }),
  );
  let held: { run(): void; cancel(): void } | null = null;
  navigation.registerGuard({
    dirty: () => true,
    request: (intent) => {
      held = intent;
    },
    cancel: () => {
      const prior = held;
      held = null;
      prior?.cancel();
    },
  });
  const unblock = history.block({ blockerFn: async () => !(await navigation.allowDeparture()) });
  try {
    const back = popped();
    history.back();
    await back;
    const oldDecision = held;
    expect(oldDecision).not.toBeNull();
    const returned = popped();
    const next = navigation.transition(
      {
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        destination: { kind: "editor" },

        work: { kind: "none" },
        results: false,
      },
      { replace: false },
    );
    const replacement = ((): { run(): void; cancel(): void } | null => held)();
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(oldDecision);
    await returned;
    expect(held).toBe(replacement);
    if (!replacement) throw new Error("Replacement decision was lost");
    replacement.run();
    await expect(next).resolves.toEqual({ kind: "applied" });
    expect(window.location.pathname).toBe("/p/550e8400-e29b-41d4-a716-446655440000/editor");
  } finally {
    unblock();
    navigation.dispose();
    history.destroy();
  }
});
