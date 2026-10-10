import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import { parseProjectAddress } from "./project-address";
import { createProjectNavigation, type DisplayedProjectSelection } from "./project-navigation";

function address(href: string) {
  const [path, query] = href.split("?");
  const parsed = parseProjectAddress(path, query);
  if (parsed.kind !== "valid") throw new Error(parsed.reason);
  return parsed.address;
}
function setup(
  initial: string,
  displayed: DisplayedProjectSelection = { work: { kind: "none" } },
  restore?: () => undefined | Promise<boolean>,
) {
  const history = createMemoryHistory({ initialEntries: [initial] });
  const changes: string[] = [];
  const navigation = createProjectNavigation(
    {
      read: () => ({
        href: history.location.href,
        key: history.location.state.__TSR_key ?? "",
        state: { ...history.location.state },
      }),
      subscribe: (listener) => history.subscribe(listener),
      flush: () => history.flush(),
      settlePendingTraversal: restore ?? (() => history.settlePendingTraversal()),
      replaceEntry(href, state) {
        changes.push(`freeze:${href}`);
        history.replace(href, state);
      },
      async navigate(href, { replace, state }) {
        changes.push(`${replace ? "replace" : "push"}:${href}`);
        if (replace) history.replace(href, state);
        else history.push(href, state);
      },
    },
    () => displayed,
  );
  return { history, navigation, changes };
}

describe("project navigation", () => {
  it.each([
    true,
    false,
  ])("revalidates competing intents after native restoration (restored: %s)", async (restored) => {
    let finish!: (restored: boolean) => void;
    const restoration = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const { navigation, changes, history } = setup(
      "/p/550e8400-e29b-41d4-a716-446655440000/editor",
      undefined,
      () => restoration,
    );
    const first = navigation.transition(address("/p/550e8400-e29b-41d4-a716-446655440000"), {
      replace: false,
    });
    const second = navigation.transition(address("/p/550e8400-e29b-41d4-a716-446655440000/works"), {
      replace: false,
    });
    expect(changes).toEqual([]);
    finish(restored);
    await expect(first).resolves.toEqual({ kind: "superseded" });
    await expect(second).resolves.toEqual({ kind: restored ? "applied" : "superseded" });
    expect(history.location.pathname).toBe(
      restored
        ? "/p/550e8400-e29b-41d4-a716-446655440000/works"
        : "/p/550e8400-e29b-41d4-a716-446655440000/editor",
    );
    navigation.dispose();
  });
  it("rejects an effect rendered for a different entry, including equal-href history entries", () => {
    const { history, navigation } = setup("/p/550e8400-e29b-41d4-a716-446655440000/editor");
    const rendered = { href: history.location.href, key: history.location.state.__TSR_key ?? "" };
    history.push("/p/550e8400-e29b-41d4-a716-446655440000/works");
    expect(navigation.captureForEntry(rendered.key)).toBeNull();
    history.push(rendered.href);
    expect(navigation.captureForEntry(rendered.key)).toBeNull();
    expect(navigation.captureForEntry(history.location.state.__TSR_key ?? "")).not.toBeNull();
    navigation.dispose();
  });
  it("rejects stale repairs even after Back returns to the same entry and href", async () => {
    const { history, navigation } = setup("/p/550e8400-e29b-41d4-a716-446655440000/editor");
    const ticket = navigation.capture();
    await navigation.navigate(address("/p/550e8400-e29b-41d4-a716-446655440000/works"), {
      replace: false,
    });
    history.back();
    expect(history.location.href).toBe(ticket.href);
    expect(
      await navigation.replaceIfCurrent(
        ticket,
        address("/p/550e8400-e29b-41d4-a716-446655440000/editor/manuscript/renamed.md"),
      ),
    ).toEqual({ kind: "superseded" });
    const current = navigation.capture();
    expect(
      await navigation.replaceIfCurrent(
        current,
        address("/p/550e8400-e29b-41d4-a716-446655440000/editor/manuscript/current.md"),
      ),
    ).toEqual({ kind: "replaced" });
    navigation.dispose();
  });
});

it("commits prepared workspace changes only inside accepted history, never on cancel or supersession", async () => {
  const { history, navigation } = setup(
    "/p/550e8400-e29b-41d4-a716-446655440000/editor/manuscript/a",
  );
  let decision!: { run(): void; cancel(): void };
  navigation.registerGuard({
    request: (intent) => {
      decision = intent;
    },
    dirty: () => true,
    cancel: () => undefined,
  });
  let closes = 0;
  const prepared = {
    isCurrent: () => true,
    commit: () => {
      expect(history.location.href).toBe("/p/550e8400-e29b-41d4-a716-446655440000/editor");
      closes += 1;
    },
  };
  const cancelled = navigation.transition(
    address("/p/550e8400-e29b-41d4-a716-446655440000/editor"),
    { replace: true },
    prepared,
  );
  expect(history.location.href).toBe("/p/550e8400-e29b-41d4-a716-446655440000/editor/manuscript/a");
  expect(closes).toBe(0);
  decision.cancel();
  expect(await cancelled).toEqual({ kind: "cancelled" });
  const superseded = navigation.transition(
    address("/p/550e8400-e29b-41d4-a716-446655440000/editor"),
    { replace: true },
    prepared,
  );
  const staleDecision = decision;
  navigation.beginIntent();
  staleDecision.run();
  expect(await superseded).toEqual({ kind: "superseded" });
  expect(closes).toBe(0);
  const accepted = navigation.transition(
    address("/p/550e8400-e29b-41d4-a716-446655440000/editor"),
    { replace: true },
    prepared,
  );
  decision.run();
  expect(closes).toBe(1);
  expect(await accepted).toEqual({ kind: "applied" });
  navigation.dispose();
});

it("revalidates the member before dispatching a held navigation", async () => {
  const { history, navigation } = setup(
    "/p/550e8400-e29b-41d4-a716-446655440000/editor/manuscript/a",
  );
  let accept!: () => void;
  navigation.registerGuard({
    request: (intent) => {
      accept = intent.run;
    },
    dirty: () => true,
    cancel: () => undefined,
  });
  let currentMember = "first";
  let committed = false;
  const pending = navigation.transition(
    address("/p/550e8400-e29b-41d4-a716-446655440000/editor"),
    { replace: true },
    {
      isCurrent: () => currentMember === "first",
      commit: () => {
        committed = true;
      },
    },
  );
  currentMember = "reopened";
  accept();
  expect(await pending).toEqual({ kind: "superseded" });
  expect(committed).toBe(false);
  expect(history.location.href).toBe("/p/550e8400-e29b-41d4-a716-446655440000/editor/manuscript/a");
  navigation.dispose();
});

it("address replacement neither prompts nor supersedes a pending writer navigation", async () => {
  const { navigation, changes } = setup(
    "/p/550e8400-e29b-41d4-a716-446655440000/editor/manuscript/a",
  );
  let decision!: { run(): void; cancel(): void };
  const request = vi.fn((intent: { run(): void; cancel(): void }) => {
    decision = intent;
  });
  navigation.registerGuard({ request, dirty: () => true, cancel: () => undefined });
  const pending = navigation.transition(address("/p/550e8400-e29b-41d4-a716-446655440000/works"), {
    replace: false,
  });
  expect(
    await navigation.replaceIfCurrent(
      navigation.capture(),
      address("/p/550e8400-e29b-41d4-a716-446655440000/editor/manuscript/a?draft=draft-a"),
    ),
  ).toEqual({ kind: "superseded" });
  expect(request).toHaveBeenCalledOnce();
  expect(changes).toEqual([]);
  decision.run();
  await expect(pending).resolves.toEqual({ kind: "applied" });
  expect(changes.at(-1)).toContain("push:/p/550e8400-e29b-41d4-a716-446655440000/works");
  navigation.dispose();
});

it("writes the accepted native history entry before committing the workspace", async () => {
  const source = "/p/550e8400-e29b-41d4-a716-446655440000/chats";
  const destination = "/p/550e8400-e29b-41d4-a716-446655440000/editor";
  let entry = { href: source, key: "source", state: {} as Record<string, unknown> };
  let nativeHref = source;
  let listener = () => {};
  const navigation = createProjectNavigation(
    {
      read: () => entry,
      subscribe: (next) => {
        listener = next;
        return () => {};
      },
      flush: () => {
        nativeHref = entry.href;
      },
      settlePendingTraversal: () => undefined,
      replaceEntry: (href, state) => {
        entry = { ...entry, href, state };
      },
      navigate: async (href, { state }) => {
        entry = { href, key: "destination", state: state ?? {} };
        listener();
      },
    },
    () => ({ work: { kind: "none" } }),
  );
  const result = await navigation.transition(
    address(destination),
    { replace: false },
    {
      isCurrent: () => true,
      commit: () => expect(nativeHref).toBe(destination),
    },
  );
  expect(result.kind).toBe("applied");
  navigation.dispose();
});
