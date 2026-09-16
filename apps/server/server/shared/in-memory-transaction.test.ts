/** Cross-participant invariants and entity isolation in hermetic transactions. */
import { describe, expect, it } from "vitest";
import { InMemoryTransactionOwner } from "./in-memory-transaction.js";

describe("shared in-memory transaction", () => {
  it("rejects writes based on a concurrently changed read participant", async () => {
    const owner = new InMemoryTransactionOwner();
    const lifecycle = owner.map<string, string>();
    const membership = owner.map<string, string>();
    lifecycle.set("thread", "live");
    let arrived = () => {};
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = owner
      .run(async () => {
        arrived();
        await gate;
        if (lifecycle.get("thread") === "live") membership.set("thread", "work");
      })
      .catch((error) => error.message);
    await ready;
    lifecycle.set("thread", "trashed");
    release();
    expect(await pending).toBe("Concurrent in-memory transaction conflict");
    expect(membership.has("thread")).toBe(false);
    expect(lifecycle.get("thread")).toBe("trashed");
  });

  it("detaches stored values from inputs, reads, iteration, and transaction results", async () => {
    const owner = new InMemoryTransactionOwner();
    const rows = owner.map<string, { nested: { value: string } }>();
    const input = { nested: { value: "stored" } };
    rows.set("a", input);
    const retained = rows.get("a");
    input.nested.value = "input mutation";
    if (!retained) throw new Error("Missing fixture");
    await expect(
      owner.run(async () => {
        retained.nested.value = "outside alias";
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const returned = await owner.run(async () => {
      const value = { nested: { value: "committed" } };
      rows.set("b", value);
      return value;
    });
    returned.nested.value = "returned alias";
    for (const value of rows.values()) value.nested.value = "iterator alias";
    expect(rows.get("a")?.nested.value).toBe("stored");
    expect(rows.get("b")?.nested.value).toBe("committed");
  });
});
