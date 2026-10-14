// @vitest-environment jsdom
/**
 * A command is one id with one frozen body: a lost request is resent as is, a 202 is observed until the
 * server records the answer, and an observation that finds nothing committed resends the command.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { settleCommand } from "./draft-command-transport";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const applied = { status: "applied" as const };

it("resends a request that got no answer, and carries the observed answer of a 202", async () => {
  const send = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockResolvedValueOnce({ status: "pending" });
  const observe = vi
    .fn()
    .mockResolvedValueOnce({ state: "pending" })
    .mockResolvedValueOnce({ state: "done", result: applied });
  const settled = settleCommand({ send, observe, live: () => true });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await settled).toEqual({ kind: "result", result: applied });
  expect(send).toHaveBeenCalledTimes(2);
  expect(observe).toHaveBeenCalledTimes(2);
});

it("sends the command again when nothing was committed under its id, and stops when the claim ends", async () => {
  const send = vi.fn().mockResolvedValue({ status: "pending" });
  const observe = vi
    .fn()
    .mockResolvedValueOnce({ state: "unknown" })
    .mockResolvedValue({ state: "pending" });
  let live = true;
  const settled = settleCommand({ send, observe, live: () => live });
  await vi.advanceTimersByTimeAsync(3000);
  expect(send).toHaveBeenCalledTimes(2);
  live = false;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await settled).toEqual({ kind: "revoked" });
});
