/** Account resource operations linearize command order and mutable document identity. */
import { expect, it } from "vitest";
import { ResourceLocationOperationQueue } from "./account-resource-replica";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("serializes one resource and rejects stale presentation ownership", async () => {
  const queue = new ResourceLocationOperationQueue();
  const firstGate = deferred();
  const order: string[] = [];
  const first = queue.run({ handle: "resource" }, async () => {
    order.push("first-start");
    await firstGate.promise;
    order.push("first-end");
  });
  const second = queue.run({ handle: "resource" }, async () => {
    order.push("second");
  });

  await Promise.resolve();
  expect(order).toEqual(["first-start"]);
  firstGate.resolve();
  await expect(first).resolves.toEqual({ isLatest: false });
  await expect(second).resolves.toEqual({ isLatest: true });
  expect(order).toEqual(["first-start", "first-end", "second"]);
});
