/**
 * Tests reconcile snapshot turns behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Snapshot reconciliation preserves equal graph references
 */

import type { Block, Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { reconcileSnapshotTurns } from "./reconcile-snapshot-turns";
import { createAssistantTurn, upsertBlockIn } from "./turn-ops";

const NOW = "2026-10-23T12:00:00.000Z";

function block(sequence: number, text = "text"): Block {
  return {
    id: `block-${sequence}`,
    turnId: "turn-1",
    responseId: null,
    blockType: "text",
    sequence,
    textContent: text,
    content: { text },
    createdAt: NOW,
  };
}

function turn(status: Turn["status"] = "complete"): Turn {
  return {
    ...createAssistantTurn("thread-1", "turn-1", NOW, []),
    status,
    blocks: [block(0)],
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("reconcileSnapshotTurns identity", () => {
  it("keeps the entire local graph for an equal snapshot", () => {
    const localTurn = turn();
    const local = [localTurn];
    const result = reconcileSnapshotTurns(local, clone(local));

    expect(result).toBe(local);
    expect(result[0]).toBe(localTurn);
    expect(result[0]?.blocks).toBe(localTurn.blocks);
    expect(result[0]?.blocks[0]).toBe(localTurn.blocks[0]);
  });

  it("changes only the turn whose authoritative field changed", () => {
    const unchanged = { ...turn(), id: "turn-0", blocks: [] };
    const localTurn = turn();
    const local = [unchanged, localTurn];
    const changes: ((value: Turn) => void)[] = [
      (value) => {
        value.position = 2;
      },
      (value) => {
        value.metadata = { changed: true };
      },
      (value) => {
        value.responses = [{ id: "response" } as Turn["responses"][number]];
      },
      (value) => {
        value.model = "other-model";
      },
      (value) => {
        value.writeMode = "draft";
      },
      (value) => {
        value.delivery = { byTurnId: "assistant-2" };
      },
    ];

    for (const change of changes) {
      const server = clone(local);
      const changed = server[1];
      if (!changed) throw new Error("fixture missing changed turn");
      change(changed);
      const result = reconcileSnapshotTurns(local, server);
      expect(result).not.toBe(local);
      expect(result[0]).toBe(unchanged);
      expect(result[1]).not.toBe(localTurn);
      expect(result[1]).toEqual(changed);
      expect(result[1]?.blocks).toBe(localTurn.blocks);
    }
  });

  it("drops a terminal local tail while retaining equal earlier blocks", () => {
    const localTurn = { ...turn("streaming"), blocks: [block(0), block(1, "tail")] };
    const serverTurn = { ...clone(localTurn), status: "complete" as const, blocks: [block(0)] };
    const result = reconcileSnapshotTurns([localTurn], [serverTurn]);

    expect(result[0]?.blocks).toEqual([localTurn.blocks[0]]);
    expect(result[0]?.blocks).not.toBe(localTurn.blocks);
    expect(result[0]?.blocks[0]).toBe(localTurn.blocks[0]);
  });

  it("keeps a write-once forgetting stamp and compares every block field", () => {
    const localTurn = { ...turn(), forgottenBy: "turn-2" };
    const stale: Turn = clone(localTurn);
    stale.forgottenBy = null;
    const reconciled = reconcileSnapshotTurns([localTurn], [stale]);
    expect(reconciled).toBeInstanceOf(Array);
    expect(reconciled[0]).toBe(localTurn);

    const changed = { ...localTurn.blocks[0], modelText: "new model text" } as Block;
    const upserted = upsertBlockIn([localTurn], localTurn.id, changed);
    expect(upserted?.[0]?.blocks[0]).toBe(changed);
  });
});
