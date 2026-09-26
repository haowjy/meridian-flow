import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { isInSubtree, type LineageThread, sameLineage } from "./lineage.js";

function thread(
  id: string,
  parentThreadId: string | null,
  rootThreadId: string,
  projectId = "project-1",
): LineageThread {
  return {
    id: id as ThreadId,
    projectId: projectId as ProjectId,
    parentThreadId: parentThreadId as ThreadId | null,
    rootThreadId: rootThreadId as ThreadId,
  };
}

function getThreadFrom(...rows: LineageThread[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return (id: ThreadId) => byId.get(id) ?? null;
}

describe("sameLineage", () => {
  it("is true for threads sharing a project and spawn root", () => {
    expect(sameLineage(thread("a", null, "a"), thread("c", "b", "a"))).toBe(true);
  });

  it("is false for a different spawn root", () => {
    expect(sameLineage(thread("a", null, "a"), thread("x", null, "x"))).toBe(false);
  });

  it("is false when the same root sits in a different project", () => {
    expect(sameLineage(thread("a", null, "a"), thread("a", null, "a", "project-2"))).toBe(false);
  });
});

describe("isInSubtree", () => {
  const a = thread("a", null, "a");
  const b = thread("b", "a", "a");
  const c = thread("c", "b", "a");
  const d = thread("d", "a", "a");
  const unrelated = thread("x", null, "x");
  const getThread = getThreadFrom(a, b, c, d, unrelated);

  it("includes the target itself", () => {
    expect(isInSubtree("a" as ThreadId, "a" as ThreadId, getThread)).toBe(true);
  });

  it("is true for a direct or transitive ancestor", () => {
    expect(isInSubtree("a" as ThreadId, "b" as ThreadId, getThread)).toBe(true);
    expect(isInSubtree("a" as ThreadId, "c" as ThreadId, getThread)).toBe(true);
  });

  it("is false for a descendant", () => {
    expect(isInSubtree("c" as ThreadId, "a" as ThreadId, getThread)).toBe(false);
  });

  it("is false for a sibling", () => {
    expect(isInSubtree("b" as ThreadId, "d" as ThreadId, getThread)).toBe(false);
  });

  it("is false for an unrelated thread", () => {
    expect(isInSubtree("a" as ThreadId, "x" as ThreadId, getThread)).toBe(false);
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
