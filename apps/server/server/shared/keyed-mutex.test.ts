import { describe, expect, it } from "vitest";

import { KeyedMutex } from "./keyed-mutex.js";

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

describe("KeyedMutex", () => {
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
      expect(invoked).toBe(false);
    } finally {
      heldGate.release();
      await Promise.allSettled([held]);
    }
  });

  it("does not time out a callback after it acquires the lock", async () => {
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

    try {
      await callbackGate.entered;
      callbackGate.release();
      await expect(operation).resolves.toBeUndefined();
    } finally {
      callbackGate.release();
      await Promise.allSettled([operation]);
    }
  });
});
