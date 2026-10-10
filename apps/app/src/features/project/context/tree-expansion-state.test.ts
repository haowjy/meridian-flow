import { afterEach, expect, it, vi } from "vitest";
import {
  EMPTY_TREE_EXPANSION,
  pruneTreeExpansion,
  readTreeExpansion,
  treeExpansionKey,
  writeTreeExpansion,
} from "./tree-expansion-state";

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
  writeTreeExpansion(key, state);
  expect(readTreeExpansion(key)).toEqual(state);
  for (const other of [
    treeExpansionKey("other", "project", "manuscript"),
    treeExpansionKey("account", "other", "manuscript"),
    treeExpansionKey("account", "project", "scratch"),
  ]) {
    expect(readTreeExpansion(other)).toEqual(EMPTY_TREE_EXPANSION);
    values.set(other, values.get(key) ?? "");
    expect(readTreeExpansion(other)).toEqual(EMPTY_TREE_EXPANSION);
  }
  values.clear(); // a fresh tab has no expansion seed
  expect(readTreeExpansion(key)).toEqual(EMPTY_TREE_EXPANSION);
});

it.each([
  "broken",
  '{"version":2}',
  '{"version":1,"key":"tree","expanded":true,"entries":{"folder":"true"}}',
])("rejects malformed tree data: %s", (raw) => {
  vi.stubGlobal("window", { sessionStorage: { getItem: () => raw } });
  expect(readTreeExpansion("tree")).toEqual(EMPTY_TREE_EXPANSION);
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
  expect(readTreeExpansion("tree")).toEqual(EMPTY_TREE_EXPANSION);
  expect(() => writeTreeExpansion("tree", { expanded: true, entries: {} })).not.toThrow();
});
