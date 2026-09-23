/** Coordinator policy under synchronous memory history, plus router URL decoding.
 * Native browser replace/push coalescing requires separate runtime verification. */
import { createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
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
  displayed: DisplayedProjectSelection = { chatId: null, workSlug: null },
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
      "/p/serial/editor",
      undefined,
      () => restoration,
    );
    const first = navigation.transition(address("/p/serial"), { replace: false });
    const second = navigation.transition(address("/p/serial/works"), { replace: false });
    expect(changes).toEqual([]);
    finish(restored);
    await expect(first).resolves.toEqual({ kind: "superseded" });
    await expect(second).resolves.toEqual({ kind: restored ? "applied" : "superseded" });
    expect(history.location.pathname).toBe(restored ? "/p/serial/works" : "/p/serial/editor");
    navigation.dispose();
  });

  it("captures a normalized router entry while retaining the native URL in its ticket", () => {
    const nativeHref = "/p/serial/editor?work=va%6Cid";
    const { history, navigation } = setup(nativeHref);
    const router = createRouter({ history, routeTree: createRootRoute() });
    const rendered = router.state.location;
    expect(rendered.href).toBe("/p/serial/editor?work=valid");
    expect(history.location.href).toBe(nativeHref);
    const ticket = navigation.captureForEntry(rendered.state.__TSR_key ?? "");
    expect(ticket).not.toBeNull();
    expect(ticket?.href).toBe(nativeHref);
    expect(ticket && navigation.isCurrent(ticket)).toBe(true);
    history.replace(nativeHref);
    expect(ticket && navigation.isCurrent(ticket)).toBe(false);
    navigation.dispose();
  });
  it("rejects an effect rendered for a different entry, including equal-href history entries", () => {
    const { history, navigation } = setup("/p/serial/editor");
    const rendered = { href: history.location.href, key: history.location.state.__TSR_key ?? "" };
    history.push("/p/serial/works");
    expect(navigation.captureForEntry(rendered.key)).toBeNull();
    history.push(rendered.href);
    expect(navigation.captureForEntry(rendered.key)).toBeNull();
    expect(navigation.captureForEntry(history.location.state.__TSR_key ?? "")).not.toBeNull();
    navigation.dispose();
  });
  it("freezes displayed selections before a main push without waiting for defaults", async () => {
    const { history, navigation, changes } = setup("/p/serial/editor?settings=usage", {
      chatId: "550e8400-e29b-41d4-a716-446655440000",
      workSlug: "revision",
    });
    await navigation.navigate(address("/p/serial/works"), { replace: false });
    expect(changes).toEqual([
      "freeze:/p/serial/editor?chat=550e8400-e29b-41d4-a716-446655440000&work=revision&settings=usage",
      "push:/p/serial/works?settings=usage",
    ]);
    history.back();
    expect(history.location.href).toBe(
      "/p/serial/editor?chat=550e8400-e29b-41d4-a716-446655440000&work=revision&settings=usage",
    );
    expect(history.length).toBe(2);
    navigation.dispose();
  });
  it("records explicit none when default catalogs have not produced a displayed selection", async () => {
    const { history, navigation } = setup("/p/serial/editor");
    const lateDefault = navigation.capture();
    await navigation.navigate(address("/p/serial"), { replace: false });
    expect(
      await navigation.replaceIfCurrent(
        lateDefault,
        address("/p/serial/editor?chat=new-default&work=revision"),
      ),
    ).toEqual({ kind: "superseded" });
    history.back();
    expect(history.location.href).toBe("/p/serial/editor");
    expect(history.location.state).toMatchObject({
      meridianProjectEmptySelection: { href: "/p/serial/editor", chat: true, work: true },
    });
    navigation.dispose();
  });
  it("pins empty defaults at the same clean URL and restores them through history", async () => {
    const { history, navigation, changes } = setup("/p/serial/editor");
    const empty = address("/p/serial/editor?chat=&work=");
    await navigation.replaceIfCurrent(navigation.capture(), empty);
    expect(history.location.href).toBe("/p/serial/editor");
    const restored = parseProjectAddress("/p/serial/editor", "", history.location.state);
    expect(restored).toMatchObject({
      address: { chat: { kind: "none" }, work: { kind: "none" } },
    });
    expect(
      parseProjectAddress("/p/serial/editor", "?settings=preferences", history.location.state),
    ).toMatchObject({
      address: { chat: { kind: "none" }, work: { kind: "none" } },
    });
    await navigation.replaceIfCurrent(navigation.capture(), empty);
    expect(changes).toEqual(["replace:/p/serial/editor"]);
    await navigation.navigate(
      address("/p/serial/editor?chat=550e8400-e29b-41d4-a716-446655440000&work=revision"),
      {
        replace: false,
      },
    );
    expect(history.location.state).not.toHaveProperty(
      "meridianProjectEmptySelection",
      expect.anything(),
    );
    history.back();
    expect(parseProjectAddress("/p/serial/editor", "", history.location.state)).toEqual(restored);
    expect(parseProjectAddress("/p/another/editor", "", history.location.state)).toMatchObject({
      address: { chat: { kind: "absent" }, work: { kind: "absent" } },
    });
    expect(
      parseProjectAddress(
        "/p/serial/editor",
        "?chat=550e8400-e29b-41d4-a716-446655440000",
        history.location.state,
      ),
    ).toMatchObject({
      address: {
        chat: { kind: "slug", slug: "550e8400-e29b-41d4-a716-446655440000" },
        work: { kind: "absent" },
      },
    });
    navigation.dispose();
  });
  it("replaces dock and Work choices without another Back entry", async () => {
    const { history, navigation, changes } = setup("/p/serial/manuscript/chapter.md?chat=&work=");
    await navigation.navigate(
      address(
        "/p/serial/manuscript/chapter.md?chat=550e8400-e29b-41d4-a716-446655440000&work=revision",
      ),
      {
        replace: true,
      },
    );
    expect(history.length).toBe(1);
    expect(changes).toEqual([
      "replace:/p/serial/manuscript/chapter.md?chat=550e8400-e29b-41d4-a716-446655440000&work=revision",
    ]);
    navigation.dispose();
  });
  it("never turns an explicit malformed or unavailable selection into a default", async () => {
    const { history, navigation } = setup("/p/serial/editor?chat=missing&work=bad+work");
    await navigation.navigate(address("/p/serial"), { replace: false });
    history.back();
    expect(history.location.href).toBe("/p/serial/editor?chat=missing&work=bad+work");
    navigation.dispose();
  });
  it("rejects stale repairs even after Back returns to the same entry and href", async () => {
    const { history, navigation } = setup("/p/serial/editor");
    const ticket = navigation.capture();
    await navigation.navigate(address("/p/serial/works"), { replace: false });
    history.back();
    expect(history.location.href).toBe(ticket.href);
    expect(
      await navigation.replaceIfCurrent(ticket, address("/p/serial/manuscript/renamed.md")),
    ).toEqual({ kind: "superseded" });
    const current = navigation.capture();
    expect(
      await navigation.replaceIfCurrent(current, address("/p/serial/manuscript/current.md")),
    ).toEqual({ kind: "replaced" });
    navigation.dispose();
  });
  it("retains a scoped local pointer without putting its UUID in the public URL", async () => {
    const local = { accountId: "account", projectId: "project-id", resourceHandle: "resource" };
    const { history, navigation } = setup("/p/serial/editor", {
      chatId: null,
      workSlug: null,
      local,
    });
    await navigation.navigate(address("/p/serial"), { replace: false });
    history.back();
    expect(history.location.href).toBe("/p/serial/editor");
    expect(history.location.state).toMatchObject({
      meridianProjectEmptySelection: { href: "/p/serial/editor", chat: true, work: true },
    });
    expect(history.location.state).toMatchObject({
      meridianProjectSelection: { version: 2, ...local },
    });
    navigation.dispose();
  });
});

describe("optional query entry repair", () => {
  it("replaces only the current entry without invoking destination navigation", () => {
    const { history, navigation, changes } = setup("/p/serial/editor?work=missing&chat=bad%20chat");
    navigation.repairQuerySelections(navigation.capture(), {
      chat: { status: "ready", entries: [] },
      work: { status: "ready", entries: [] },
    });
    expect(changes).toEqual(["freeze:/p/serial/editor"]);
    expect(history.length).toBe(1);
    expect(history.location.state).toMatchObject({
      meridianProjectEmptySelection: { chat: true, work: true },
    });
    navigation.dispose();
  });
  it("rejects stale validation and never rewrites valid or absent selectors", () => {
    const { history, navigation, changes } = setup("/p/serial/editor?work=missing");
    const stale = navigation.capture();
    history.push("/p/serial/editor?work=valid");
    const catalogs = {
      chat: { status: "ready", entries: [] },
      work: { status: "ready", entries: [{ slug: "valid" }] },
    } as const;
    navigation.repairQuerySelections(stale, catalogs);
    navigation.repairQuerySelections(navigation.capture(), catalogs);
    expect(changes).toEqual([]);
    expect(history.location.href).toBe("/p/serial/editor?work=valid");
    navigation.dispose();
  });
});

it("commits prepared workspace changes only inside accepted history, never on cancel or supersession", async () => {
  const { history, navigation } = setup("/p/serial/manuscript/a");
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
      expect(history.location.href).toBe("/p/serial/editor");
      closes += 1;
    },
  };
  const cancelled = navigation.transition(address("/p/serial/editor"), { replace: true }, prepared);
  expect(history.location.href).toBe("/p/serial/manuscript/a");
  expect(closes).toBe(0);
  decision.cancel();
  expect(await cancelled).toEqual({ kind: "cancelled" });
  const superseded = navigation.transition(
    address("/p/serial/editor"),
    { replace: true },
    prepared,
  );
  const staleDecision = decision;
  navigation.beginIntent();
  staleDecision.run();
  expect(await superseded).toEqual({ kind: "superseded" });
  expect(closes).toBe(0);
  const accepted = navigation.transition(address("/p/serial/editor"), { replace: true }, prepared);
  decision.run();
  expect(closes).toBe(1);
  expect(await accepted).toEqual({ kind: "applied" });
  navigation.dispose();
});

it("revalidates the member before dispatching a held navigation", async () => {
  const { history, navigation } = setup("/p/serial/manuscript/a");
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
    address("/p/serial/editor"),
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
  expect(history.location.href).toBe("/p/serial/manuscript/a");
  navigation.dispose();
});
