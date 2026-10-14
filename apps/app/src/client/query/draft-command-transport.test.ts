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

it("resends a lost request, carries the observed answer of a 202, resends when nothing was committed, and stops when the claim ends", async () => {
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

  const send2 = vi.fn().mockResolvedValue({ status: "pending" });
  const observe2 = vi
    .fn()
    .mockResolvedValueOnce({ state: "unknown" })
    .mockResolvedValue({ state: "pending" });
  let live = true;
  const settled2 = settleCommand({ send: send2, observe: observe2, live: () => live });
  await vi.advanceTimersByTimeAsync(3000);
  expect(send2).toHaveBeenCalledTimes(2);
  live = false;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await settled2).toEqual({ kind: "revoked" });

  // A revoked claim never sends, and a direct answer that lands after revocation is not published.
  const never = vi.fn().mockResolvedValue(applied);
  expect(await settleCommand({ send: never, observe: observe2, live: () => false })).toEqual({
    kind: "revoked",
  });
  expect(never).not.toHaveBeenCalled();
  let open = true;
  const late = vi.fn(async () => {
    open = false;
    return applied;
  });
  expect(await settleCommand({ send: late, observe: observe2, live: () => open })).toEqual({
    kind: "revoked",
  });
});
