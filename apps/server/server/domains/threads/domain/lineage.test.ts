import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { isInSubtree, type LineageThread } from "./lineage.js";

function thread(id: string, parentThreadId: string | null, rootThreadId: string): LineageThread {
  return {
    id: id as ThreadId,
    projectId: "project-1" as ProjectId,
    parentThreadId: parentThreadId as ThreadId | null,
    rootThreadId: rootThreadId as ThreadId,
  };
}

function getThreadFrom(...rows: LineageThread[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return (id: ThreadId) => byId.get(id) ?? null;
}

describe("isInSubtree", () => {
  const a = thread("a", null, "a");
  const b = thread("b", "a", "a");
  const c = thread("c", "b", "a");
  const getThread = getThreadFrom(a, b, c);

  it("is true for a direct or transitive ancestor", () => {
    expect(isInSubtree("a" as ThreadId, "b" as ThreadId, getThread)).toBe(true);
    expect(isInSubtree("a" as ThreadId, "c" as ThreadId, getThread)).toBe(true);
  });

  it("is false for a target that is not loaded", () => {
    expect(isInSubtree("a" as ThreadId, "ghost" as ThreadId, getThread)).toBe(false);
  });

  it("terminates on a cyclic parent chain", () => {
    const p = thread("p", "q", "p");
    const q = thread("q", "p", "p");
    const cyclic = getThreadFrom(p, q);
    expect(isInSubtree("a" as ThreadId, "p" as ThreadId, cyclic)).toBe(false);
  });
});
