/**
 * Fork/handoff derivation: the derived thread is a SIBLING of its source
 * (same parent, root, and spawn depth), never the source's child.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { buildDerivedPrimaryThreadRow } from "./thread-create-derived-primary.js";

const BASE = { userId: "user-1", projectId: "project-1", workId: null } as const;

describe("buildDerivedPrimaryThreadRow", () => {
  it("forking a primary root shares that root and has no parent", () => {
    const derived = buildDerivedPrimaryThreadRow({
      ...BASE,
      source: { parentThreadId: null, rootThreadId: "root-1" as ThreadId, spawnDepth: 0 },
      originType: "fork",
      originTurnId: "turn-1" as TurnId,
    });
    expect(derived.parentThreadId).toBeNull();
    expect(derived.rootThreadId).toBe("root-1");
    expect(derived.spawnDepth).toBe(0);
    expect(derived.id).not.toBe("root-1");
  });

  it("forking a subagent makes a sibling: same parent, root, and depth", () => {
    const source = {
      parentThreadId: "parent-1" as ThreadId,
      rootThreadId: "root-1" as ThreadId,
      spawnDepth: 2,
    };
    const derived = buildDerivedPrimaryThreadRow({
      ...BASE,
      source,
      originType: "fork",
      originTurnId: "turn-1" as TurnId,
    });
    expect(derived.parentThreadId).toBe(source.parentThreadId);
    expect(derived.rootThreadId).toBe(source.rootThreadId);
    expect(derived.spawnDepth).toBe(source.spawnDepth);
  });

  it("handoff follows the same sibling rule as fork", () => {
    const source = {
      parentThreadId: "parent-1" as ThreadId,
      rootThreadId: "root-1" as ThreadId,
      spawnDepth: 1,
    };
    const derived = buildDerivedPrimaryThreadRow({ ...BASE, source, originType: "handoff" });
    expect(derived.parentThreadId).toBe(source.parentThreadId);
    expect(derived.rootThreadId).toBe(source.rootThreadId);
    expect(derived.spawnDepth).toBe(source.spawnDepth);
  });

  it("is always kind primary regardless of the source's own kind", () => {
    const derived = buildDerivedPrimaryThreadRow({
      ...BASE,
      source: {
        parentThreadId: "parent-1" as ThreadId,
        rootThreadId: "root-1" as ThreadId,
        spawnDepth: 3,
      },
      originType: "fork",
      originTurnId: "turn-1" as TurnId,
    });
    expect(derived.kind).toBe("primary");
  });

  it("carries fork/handoff provenance on originTurnId, never on parentThreadId", () => {
    const derived = buildDerivedPrimaryThreadRow({
      ...BASE,
      source: { parentThreadId: null, rootThreadId: "root-1" as ThreadId, spawnDepth: 0 },
      originType: "fork",
      originTurnId: "turn-7" as TurnId,
    });
    expect(derived.originTurnId).toBe("turn-7");
    expect(derived.originType).toBe("fork");
    // The source thread's own id never appears on the derived row: it is
    // recovered by resolving originTurnId's owning thread, not stored here.
    expect(derived.parentThreadId).not.toBe("turn-7");
  });
});
