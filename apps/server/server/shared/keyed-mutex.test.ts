/** Consolidated test contracts; each block retains its original fixture scope. */

import { describe as __mergedSuite, afterEach, expect, it, vi } from "vitest";
/** Cross-participant invariants and entity isolation in hermetic transactions. */
import { InMemoryTransactionOwner } from "./in-memory-transaction.js";
import { KeyedMutex } from "./keyed-mutex.js";

__mergedSuite("keyed-mutex.test.ts", () => {
  // Merged from apps/server/server/shared/keyed-mutex.test.ts.
  function gate() {
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    return { blocked, entered, release, started };
  }

  __mergedSuite("KeyedMutex", () => {
    afterEach(() => {
      vi.useRealTimers();
    });
    it("serializes operations for the same key", async () => {
      const mutex = new KeyedMutex();
      const order: string[] = [];
      const firstGate = gate();
      const first = mutex.run("a", async () => {
        order.push("a-start");
        firstGate.started();
        await firstGate.blocked;
        order.push("a-end");
      });
      const second = mutex.run("a", async () => {
        order.push("b-start");
        order.push("b-end");
      });
      try {
        await firstGate.entered;
        expect(order).toEqual(["a-start"]);
        firstGate.release();
        await Promise.all([first, second]);
        expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
      } finally {
        firstGate.release();
        await Promise.allSettled([first, second]);
      }
    });
    it("runs operations for different keys concurrently", async () => {
      const mutex = new KeyedMutex();
      const order: string[] = [];
      const aGate = gate();
      const bGate = gate();
      const first = mutex.run("a", async () => {
        order.push("a-start");
        aGate.started();
        await aGate.blocked;
        order.push("a-end");
      });
      const second = mutex.run("b", async () => {
        order.push("b-start");
        bGate.started();
        await bGate.blocked;
        order.push("b-end");
      });
      try {
        await Promise.all([aGate.entered, bGate.entered]);
        expect(order).toEqual(["a-start", "b-start"]);
        bGate.release();
        aGate.release();
        await Promise.all([first, second]);
        expect(order).toEqual(["a-start", "b-start", "b-end", "a-end"]);
      } finally {
        aGate.release();
        bGate.release();
        await Promise.allSettled([first, second]);
      }
    });
    it("continues the chain after a rejecting operation", async () => {
      const mutex = new KeyedMutex();
      const order: string[] = [];
      await expect(
        mutex.run("k", async () => {
          order.push("fail");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      await mutex.run("k", async () => {
        order.push("after");
      });
      expect(order).toEqual(["fail", "after"]);
    });
    it("times out only while waiting and never invokes the cancelled callback", async () => {
      const mutex = new KeyedMutex();
      const heldGate = gate();
      const held = mutex.run("k", async () => {
        heldGate.started();
        await heldGate.blocked;
      });
      let invoked = false;
      try {
        await heldGate.entered;
        await expect(
          mutex.run(
            "k",
            async () => {
              invoked = true;
            },
            { timeoutMs: 5 },
          ),
        ).rejects.toThrow("Timed out acquiring lock");
        heldGate.release();
        await held;
        await mutex.run("k", async () => {});
        expect(invoked).toBe(false);
      } finally {
        heldGate.release();
        await Promise.allSettled([held]);
      }
    });
    it("does not time out a callback after it acquires the lock", async () => {
      vi.useFakeTimers();
      const mutex = new KeyedMutex();
      const callbackGate = gate();
      const operation = mutex.run(
        "k",
        async () => {
          callbackGate.started();
          await callbackGate.blocked;
        },
        { timeoutMs: 5 },
      );
      let outcome: "pending" | "resolved" | "rejected" = "pending";
      void operation.then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "rejected";
        },
      );
      try {
        await callbackGate.entered;
        await vi.advanceTimersByTimeAsync(10);
        expect(outcome).toBe("pending");
        callbackGate.release();
        await expect(operation).resolves.toBeUndefined();
        expect(outcome).toBe("resolved");
      } finally {
        callbackGate.release();
        await Promise.allSettled([operation]);
        vi.useRealTimers();
      }
    });
  });
});

__mergedSuite("in-memory-transaction.test.ts", () => {
  // Merged from apps/server/server/shared/in-memory-transaction.test.ts.
  __mergedSuite("shared in-memory transaction", () => {
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
      const rows = owner.map<
        string,
        {
          nested: {
            value: string;
          };
        }
      >();
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
});
