/** Project history policy exercised with the installed router history implementation. */
import { createMemoryHistory } from "@tanstack/react-router";
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
  displayed: DisplayedProjectSelection = { chatSlug: null, workSlug: null },
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
  it("rejects an effect rendered for a different entry, including equal-href history entries", () => {
    const { history, navigation } = setup("/p/serial/editor");
    const rendered = { href: history.location.href, key: history.location.state.__TSR_key ?? "" };
    history.push("/p/serial/works");
    expect(navigation.captureForEntry(rendered)).toBeNull();
    history.push(rendered.href);
    expect(navigation.captureForEntry(rendered)).toBeNull();
    expect(
      navigation.captureForEntry({
        href: history.location.href,
        key: history.location.state.__TSR_key ?? "",
      }),
    ).not.toBeNull();
    navigation.dispose();
  });
  it("freezes displayed selections before a main push without waiting for defaults", async () => {
    const { history, navigation, changes } = setup("/p/serial/editor?settings=usage", {
      chatSlug: "fight-scene",
      workSlug: "revision",
    });
    await navigation.navigate(address("/p/serial/works"), { replace: false });
    expect(changes).toEqual([
      "freeze:/p/serial/editor?chat=fight-scene&work=revision&settings=usage",
      "push:/p/serial/works?settings=usage",
    ]);
    history.back();
    expect(history.location.href).toBe(
      "/p/serial/editor?chat=fight-scene&work=revision&settings=usage",
    );
    expect(history.length).toBe(2);
    navigation.dispose();
  });
  it("records explicit none when default catalogs have not produced a displayed selection", async () => {
    const { history, navigation } = setup("/p/serial/editor");
    const lateDefault = navigation.capture();
    await navigation.navigate(address("/p/serial/chats"), { replace: false });
    expect(
      await navigation.replaceIfCurrent(
        lateDefault,
        address("/p/serial/editor?chat=new-default&work=revision"),
      ),
    ).toBe(false);
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
    await navigation.navigate(address("/p/serial/editor?chat=other&work=revision"), {
      replace: false,
    });
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
      parseProjectAddress("/p/serial/editor", "?chat=other", history.location.state),
    ).toMatchObject({
      address: { chat: { kind: "slug", slug: "other" }, work: { kind: "absent" } },
    });
    navigation.dispose();
  });
  it("replaces dock and Work choices without another Back entry", async () => {
    const { history, navigation, changes } = setup("/p/serial/manuscript/chapter.md?chat=&work=");
    await navigation.navigate(address("/p/serial/manuscript/chapter.md?chat=other&work=revision"), {
      replace: true,
    });
    expect(history.length).toBe(1);
    expect(changes).toEqual(["replace:/p/serial/manuscript/chapter.md?chat=other&work=revision"]);
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
    ).toBe(false);
    const current = navigation.capture();
    expect(
      await navigation.replaceIfCurrent(current, address("/p/serial/manuscript/current.md")),
    ).toBe(true);
    navigation.dispose();
  });
  it("retains a scoped local pointer without putting its UUID in the public URL", async () => {
    const local = { accountId: "account", projectId: "project-id", threadId: "pending-thread" };
    const { history, navigation } = setup("/p/serial/editor", {
      chatSlug: null,
      workSlug: null,
      local,
    });
    await navigation.navigate(address("/p/serial/chats"), { replace: false });
    history.back();
    expect(history.location.href).toBe("/p/serial/editor");
    expect(history.location.state).toMatchObject({
      meridianProjectEmptySelection: { href: "/p/serial/editor", chat: true, work: true },
    });
    expect(history.location.state).toMatchObject({
      meridianProjectSelection: { version: 1, ...local },
    });
    navigation.dispose();
  });
});
