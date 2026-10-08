/** Namespace reversal settles links before reserving a transaction or claiming the handle. */
import { describe, expect, it } from "vitest";
import { Ok } from "../../../shared/result.js";
import { createNamespaceChanges, type NamespaceTree } from "./namespace-changes.js";
import type {
  AgentNamespaceChangeStore,
  NamespaceChangeRecord,
} from "./ports/agent-namespace-changes.js";

describe("namespace reversal settlement", () => {
  it.each([
    "undo",
    "redo",
  ] as const)("settles before the %s transaction and uses the settled tree", async (direction) => {
    const events: string[] = [];
    const tree: NamespaceTree<never> = {
      async settleLinks(uris) {
        events.push(`settle:${uris.join()}`);
        return {
          ...tree,
          async move(from, to) {
            events.push(`move:${from}:${to}`);
            return Ok(undefined);
          },
        };
      },
      async move() {
        throw new Error("Unsettled move");
      },
      async delete() {
        return Ok(undefined);
      },
      async restore() {
        return Ok(undefined);
      },
      async lock() {
        return Ok(undefined);
      },
    };
    const changes = createNamespaceChanges({
      store: {
        async transition() {
          events.push("claim");
          return true;
        },
      } as unknown as AgentNamespaceChangeStore,
      async atomic(operation) {
        events.push("begin");
        const value = await operation();
        events.push("commit");
        return value;
      },
      draftHistory: { branches: {} as never, branchRows: {} as never },
    });
    const change: NamespaceChangeRecord = {
      id: 1,
      documentId: "doc",
      wId: 1,
      turnId: null,
      draftBranchId: null,
      status: "active",
      reversedAt: null,
      kind: "move",
      fromUri: "A",
      toUri: "B",
    };
    expect(await changes.reverse(tree, change, direction)).toEqual(Ok(undefined));
    const [from, to] = direction === "undo" ? ["B", "A"] : ["A", "B"];
    expect(events).toEqual([`settle:${from}`, "begin", "claim", `move:${from}:${to}`, "commit"]);
  });
});
