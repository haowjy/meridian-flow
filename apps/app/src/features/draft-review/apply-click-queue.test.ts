/** Delivery schedules a browser cannot reliably hold: immutable retries, row/answer ordering and closes. */

import type {
  ApplyClick,
  ApplyClickAnswer,
  ApplyClickObservation,
} from "@meridian/contracts/branches";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplyClickQueue } from "./apply-click-queue";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const body = (id: string): ApplyClick => ({
  commandId: id,
  snapshot: `snapshot-${id}`,
  baseViewDelta: [],
  groupIds: [`group-${id}`],
});
const frozen = (id: string, acknowledged = Promise.resolve()) => ({
  body: body(id),
  optimistic: [],
  patched: [],
  acknowledged,
});
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("retries a lost answer with the identical body at 1/2/4 seconds, then stalls without sending its successor", async () => {
  const send = vi
    .fn<(body: ApplyClick) => Promise<ApplyClickAnswer>>()
    .mockRejectedValue(new Error("lost"));
  const queue = new ApplyClickQueue({ send, lookup: vi.fn(), changed() {}, refused() {} });
  const first = frozen("first");
  const result = queue.enqueue(first);
  queue.enqueue(frozen("second"));
  await flush();
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(send).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(send).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(4000);
  expect(send).toHaveBeenCalledTimes(4);
  expect(queue.clicks[0].stalled).toBe(true);
  expect(send.mock.calls.every(([request]) => request === first.body)).toBe(true);
  send.mockResolvedValue({ status: "applied", commandId: "first" });
  queue.retry();
  await flush();
  expect(queue.clicks).toHaveLength(2);
  queue.observe(["first"]);
  await flush();
  expect(await result).toEqual({ status: "applied", commandId: "first" });
  expect(send.mock.calls.at(-1)?.[0].commandId).toBe("second");
  queue.destroy();
});

it("releases the head on the record before an answer and reports the answer's outcome, or waits for the record after an applied answer; a later ack never blocks a ready head", async () => {
  const answer = deferred<ApplyClickAnswer>();
  const laterAck = deferred<void>();
  const send = vi
    .fn<(body: ApplyClick) => Promise<ApplyClickAnswer>>()
    .mockReturnValueOnce(answer.promise)
    .mockImplementation(async (request) => ({ status: "applied", commandId: request.commandId }));
  const queue = new ApplyClickQueue({ send, lookup: vi.fn(), changed() {}, refused() {} });
  const result = queue.enqueue(frozen("first"));
  queue.enqueue(frozen("second", laterAck.promise));
  await flush();
  expect(send).toHaveBeenCalledTimes(1);
  queue.observe(["first"]);
  await flush();
  expect(send).toHaveBeenCalledTimes(1);
  laterAck.resolve();
  await flush();
  expect(send).toHaveBeenCalledTimes(2);
  expect(queue.clicks).toHaveLength(1);
  // Landed by the record; the late answer still says what the record can't.
  answer.resolve({ status: "applied", commandId: "first", restored: true });
  expect(await result).toEqual({ status: "applied", commandId: "first", restored: true });
  expect(queue.clicks[0].body.commandId).toBe("second");
  queue.observe(["first", "second"]);
  expect(queue.clicks).toHaveLength(0);
  queue.destroy();
});

it("a terminal close cancels unsent clicks and settles a sent head from its answer or same-id durable lookup without a room record", async () => {
  for (const status of ["applied", "none"] as const) {
    const answer = deferred<ApplyClickAnswer>();
    const lookup = vi.fn(
      async (request: ApplyClick): Promise<ApplyClickObservation> => ({
        status,
        commandId: request.commandId,
      }),
    );
    const queue = new ApplyClickQueue({
      send: () => answer.promise,
      lookup,
      changed() {},
      refused() {},
    });
    const first = queue.enqueue(frozen("first"));
    const second = queue.enqueue(frozen("second"));
    await flush();
    queue.close();
    expect(await second).toEqual({ status: "cancelled" });
    answer.resolve({ status: "pending", commandId: "first" });
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(lookup).toHaveBeenCalledWith(body("first"));
    expect(await first).toEqual(
      status === "applied" ? { status, commandId: "first" } : { status: "cancelled" },
    );
    expect(queue.clicks).toHaveLength(0);
    queue.destroy();
  }
  const answer = deferred<ApplyClickAnswer>();
  const queue = new ApplyClickQueue({
    send: () => answer.promise,
    lookup: vi.fn(),
    changed() {},
    refused() {},
  });
  const result = queue.enqueue(frozen("answered"));
  await flush();
  answer.resolve({ status: "applied", commandId: "answered" });
  await flush();
  expect(queue.clicks).toHaveLength(1);
  queue.close();
  expect(await result).toEqual({ status: "applied", commandId: "answered" });
  queue.destroy();
});

it("one refusal in the middle removes only its contribution, reports on the item and sends the next frozen click", async () => {
  const refused = vi.fn();
  const send = vi.fn(
    async (request: ApplyClick): Promise<ApplyClickAnswer> =>
      request.commandId === "second"
        ? { status: "refused", commandId: request.commandId, reason: "work_archived" }
        : { status: "applied", commandId: request.commandId },
  );
  const queue = new ApplyClickQueue({ send, lookup: vi.fn(), changed() {}, refused });
  queue.enqueue(frozen("first"));
  const second = queue.enqueue(frozen("second"));
  queue.enqueue(frozen("third"));
  await flush();
  queue.observe(["first"]);
  await flush();
  expect(await second).toEqual({ status: "refused", commandId: "second", reason: "work_archived" });
  expect(refused).toHaveBeenCalledTimes(1);
  expect(send.mock.calls.map(([request]) => request.commandId)).toEqual([
    "first",
    "second",
    "third",
  ]);
  expect(queue.clicks.map((click) => click.body.commandId)).toEqual(["third"]);
  queue.destroy();
});
