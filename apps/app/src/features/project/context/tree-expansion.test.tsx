// @vitest-environment jsdom
/** React disclosure ownership survives remount and storage failure without scope bleed. */
import { act, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  EMPTY_TREE_EXPANSION,
  pruneTreeExpansion,
  readTreeExpansion,
  treeExpansionKey,
  writeTreeExpansion,
} from "./tree-expansion-state";
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

afterEach(() => vi.unstubAllGlobals());

it("restores only this tab's account, project, and tree, including explicit collapses", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  const key = treeExpansionKey("account", "project", "manuscript");
  const state = { expanded: true, entries: { folder: true, closed: false } };
  writeTreeExpansion(key, "account", state);
  expect(readTreeExpansion(key, "account")).toEqual(state);
  for (const other of [
    treeExpansionKey("other", "project", "manuscript"),
    treeExpansionKey("account", "other", "manuscript"),
    treeExpansionKey("account", "project", "scratch"),
  ]) {
    expect(readTreeExpansion(other, "account")).toEqual(EMPTY_TREE_EXPANSION);
    values.set(other, values.get(key) ?? "");
    expect(readTreeExpansion(other, "account")).toEqual(EMPTY_TREE_EXPANSION);
  }
  values.clear(); // a fresh tab has no expansion seed
  expect(readTreeExpansion(key, "account")).toEqual(EMPTY_TREE_EXPANSION);
});

it("rejects malformed tree data: broken", () => {
  const raw = "broken";
  vi.stubGlobal("window", { sessionStorage: { getItem: () => raw } });
  expect(readTreeExpansion("tree", "account")).toEqual(EMPTY_TREE_EXPANSION);
});

it("drops missing folders and keeps explicit closed folders", () => {
  expect(
    pruneTreeExpansion({ expanded: true, entries: { gone: true, kept: false } }, ["kept"]),
  ).toEqual({ expanded: true, entries: { kept: false } });
});

it("tolerates blocked storage", () => {
  vi.stubGlobal("window", {
    get sessionStorage() {
      throw Error("blocked");
    },
  });
  expect(readTreeExpansion("tree", "account")).toEqual(EMPTY_TREE_EXPANSION);
  expect(() =>
    writeTreeExpansion("tree", "account", { expanded: true, entries: {} }),
  ).not.toThrow();
});
