/** Late snapshot errors report their request's start bind, never the observer's current bind. */
import { expect, it } from "vitest";
import { threadSnapshotErrorEpoch, withThreadSnapshotEpoch } from "./thread-snapshot-epoch";

it("retains the start epoch on the same typed error after a later bind", async () => {
  const error = new Error("missing");
  let reject!: (error: Error) => void;
  let epoch = 1;
  const request = withThreadSnapshotEpoch(
    epoch,
    () =>
      new Promise<never>((_, fail) => {
        reject = fail;
      }),
  );
  epoch = 3;
  reject(error);
  await expect(request).rejects.toBe(error);
  expect(threadSnapshotErrorEpoch(error)).toBe(1);
  expect(threadSnapshotErrorEpoch(new Error("unrelated"))).toBeUndefined();
  expect(epoch).toBe(3);
});
