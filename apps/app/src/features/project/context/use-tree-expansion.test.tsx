// @vitest-environment jsdom
/** React disclosure ownership survives remount and storage failure without scope bleed. */
import { act, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { treeExpansionKey } from "./tree-expansion-state";
import { useTreeExpansion } from "./use-tree-expansion";

vi.mock("./account-feature-context", () => ({ useAccountId: () => "account" }));
afterEach(() => vi.restoreAllMocks());

it("keeps live toggles in memory when storage is blocked", async () => {
  const folders = ["folder"];
  function Tree() {
    const tree = useTreeExpansion("project", "manuscript", folders);
    return (
      <button
        type="button"
        aria-expanded={tree.expanded}
        onClick={() => tree.setExpanded(!tree.expanded)}
      >
        Tree
      </button>
    );
  }
  await withReactRoot(<Tree />, async () => {
    Object.defineProperty(window, "sessionStorage", {
      get: () => {
        throw Error("blocked");
      },
    });
    const button = document.querySelector("button");
    await act(async () => button?.click());
    expect(button?.getAttribute("aria-expanded")).toBe("true");
  });
});

it("does not prune unloaded catalogs and restores independent tree scopes", async () => {
  const folders = ["kept"];
  function Harness() {
    const [scope, setScope] = useState("first");
    const [loaded, setLoaded] = useState(false);
    const tree = useTreeExpansion("project", scope, loaded ? folders : null);
    return (
      <>
        <button type="button" onClick={() => tree.setExpandedEntryIds({ kept: true, gone: true })}>
          Expand
        </button>
        <button type="button" onClick={() => setLoaded(true)}>
          Load
        </button>
        <button type="button" onClick={() => setScope(scope === "first" ? "second" : "first")}>
          Scope
        </button>
        <output>{JSON.stringify(tree.expandedEntryIds)}</output>
      </>
    );
  }
  await withReactRoot(<Harness />, async () => {
    const buttons = document.querySelectorAll("button");
    await act(async () => buttons[0]?.click());
    expect(document.querySelector("output")?.textContent).toContain("gone");
    await act(async () => buttons[1]?.click());
    expect(document.querySelector("output")?.textContent).toBe('{"kept":true}');
    expect(
      window.sessionStorage.getItem(treeExpansionKey("account", "project", "first")),
    ).not.toContain("gone");
    await act(async () => buttons[2]?.click());
    expect(document.querySelector("output")?.textContent).toBe("{}");
    await act(async () => buttons[2]?.click());
    expect(document.querySelector("output")?.textContent).toBe('{"kept":true}');
  });
});
