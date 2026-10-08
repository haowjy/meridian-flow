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
      id: "fork-1" as ThreadId,
      source: { parentThreadId: null, rootThreadId: "root-1" as ThreadId, spawnDepth: 0 },
      originType: "fork",
      originTurnId: "turn-1" as TurnId,
    });
    expect(derived.parentThreadId).toBeNull();
    expect(derived.rootThreadId).toBe("root-1");
    expect(derived.spawnDepth).toBe(0);
    expect(derived.id).toBe("fork-1");
  });

  it("forking a subagent makes a sibling: same parent, root, and depth", () => {
    const source = {
      parentThreadId: "parent-1" as ThreadId,
      rootThreadId: "root-1" as ThreadId,
      spawnDepth: 2,
    };
    const derived = buildDerivedPrimaryThreadRow({
      ...BASE,
      id: "fork-2" as ThreadId,
      source,
      originType: "fork",
      originTurnId: "turn-1" as TurnId,
    });
    expect(derived.parentThreadId).toBe(source.parentThreadId);
    expect(derived.rootThreadId).toBe(source.rootThreadId);
    expect(derived.spawnDepth).toBe(source.spawnDepth);
  });

  it("handoff keeps sibling provenance but starts a fresh lineage", () => {
    const source = {
      parentThreadId: "parent-1" as ThreadId,
      rootThreadId: "root-1" as ThreadId,
      spawnDepth: 1,
    };
    const derived = buildDerivedPrimaryThreadRow({
      ...BASE,
      id: "handoff-1" as ThreadId,
      source,
      originType: "handoff",
    });
    expect(derived.parentThreadId).toBe(source.parentThreadId);
    expect(derived.rootThreadId).toBe(derived.id);
    expect(derived.spawnDepth).toBe(source.spawnDepth);
  });

  it("is always kind primary regardless of the source's own kind", () => {
    const derived = buildDerivedPrimaryThreadRow({
      ...BASE,
      id: "fork-3" as ThreadId,
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
      id: "fork-4" as ThreadId,
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
