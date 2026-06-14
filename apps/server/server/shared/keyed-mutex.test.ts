import { describe, expect, it } from "vitest";

import { KeyedMutex } from "./keyed-mutex.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("KeyedMutex", () => {
  it("serializes operations for the same key", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const first = mutex.run("a", async () => {
      order.push("a-start");
      await delay(20);
      order.push("a-end");
    });
    const second = mutex.run("a", async () => {
      order.push("b-start");
      order.push("b-end");
    });

    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("runs operations for different keys concurrently", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const first = mutex.run("a", async () => {
      order.push("a-start");
      await delay(30);
      order.push("a-end");
    });
    const second = mutex.run("b", async () => {
      order.push("b-start");
      await delay(5);
      order.push("b-end");
    });

    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "b-start", "b-end", "a-end"]);
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

  it("returns resolved values and propagates errors to the caller", async () => {
    const mutex = new KeyedMutex();

    await expect(mutex.run("k", async () => 42)).resolves.toBe(42);
    await expect(
      mutex.run("k", async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
  });

  it("accepts a fresh operation after the chain for a key has drained", async () => {
    const mutex = new KeyedMutex();

    await mutex.run("k", async () => "first");
    await mutex.run("k", async () => "second");

    await expect(mutex.run("k", async () => "third")).resolves.toBe("third");
  });
});
