/** Delivery schedules a browser cannot reliably hold: immutable retries, row/answer ordering and closes.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - ordered Apply delivery, settled on the stored answer
 */

import type {
  ApplyClick,
  ApplyClickAnswer,
  ApplyClickObservation,
} from "@meridian/contracts/branches";
import type { Settlement } from "@meridian/contracts/commands";
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
  draftId: "draft",
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

it("retries a lost answer with the identical body at 1/2/4 seconds, then gives the click up as unsent when the server stored nothing, and sends its successor", async () => {
  const send = vi
    .fn<(body: ApplyClick) => Promise<ApplyClickAnswer>>()
    .mockRejectedValue(new Error("lost"));
  const lookup = vi.fn(
    async (request: ApplyClick): Promise<ApplyClickObservation> => ({
      status: "none",
      commandId: request.commandId,
    }),
  );
  const queue = new ApplyClickQueue({ node: "d", send, lookup, changed() {} });
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
  expect(send.mock.calls.slice(0, 4).every(([request]) => request === first.body)).toBe(true);
  expect(await result).toEqual({ status: "unsent", commandId: "first" });
  expect(lookup).toHaveBeenCalledWith(first.body);
  expect(send).toHaveBeenCalledTimes(5);
  expect(send.mock.calls.at(-1)?.[0].commandId).toBe("second");
  queue.destroy();
});

it("settles the head on its stored answer and sends the next once its ack is in; a later ack never blocks a ready head", async () => {
  const answer = deferred<ApplyClickAnswer>();
  const laterAck = deferred<void>();
  const send = vi
    .fn<(body: ApplyClick) => Promise<ApplyClickAnswer>>()
    .mockReturnValueOnce(answer.promise)
    .mockImplementation(async (request) => ({
      status: "applied",
      commandId: request.commandId,
      items: [{ node: "d", text: { landed: true } }],
      applied: [],
    }));
  const queue = new ApplyClickQueue({ node: "d", send, lookup: vi.fn(), changed() {} });
  const result = queue.enqueue(frozen("first"));
  const second = queue.enqueue(frozen("second", laterAck.promise));
  await flush();
  expect(send).toHaveBeenCalledTimes(1);
  const stored: ApplyClickAnswer = {
    status: "applied",
    commandId: "first",
    items: [
      { node: "d", text: { landed: true, settled: [{ rule: "restored", documentId: "d" }] } },
    ],
    applied: [],
  };
  answer.resolve(stored);
  expect(await result).toEqual(stored);
  await flush();
  expect(send).toHaveBeenCalledTimes(1);
  laterAck.resolve();
  await expect(second).resolves.toEqual({
    status: "applied",
    commandId: "second",
    items: [{ node: "d", text: { landed: true } }],
    applied: [],
  });
  queue.destroy();
});

it("a terminal close cancels unsent clicks and settles a sent head from its answer or same-id durable lookup", async () => {
  for (const status of ["applied", "none"] as const) {
    const answer = deferred<ApplyClickAnswer>();
    const lookup = vi.fn(
      async (request: ApplyClick): Promise<ApplyClickObservation> =>
        status === "applied"
          ? {
              status,
              commandId: request.commandId,
              items: [{ node: "d", text: { landed: true } }],
              applied: [],
            }
          : { status, commandId: request.commandId },
    );
    const queue = new ApplyClickQueue({
      node: "d",
      send: () => answer.promise,
      lookup,
      changed() {},
    });
    const first = queue.enqueue(frozen("first"));
    const second = queue.enqueue(frozen("second"));
    await flush();
    queue.close();
    expect(await second).toEqual({ status: "cancelled" });
    answer.resolve({ status: "conflict", commandId: "first" });
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(lookup).toHaveBeenCalledWith(body("first"));
    expect(await first).toEqual(
      status === "applied"
        ? {
            status,
            commandId: "first",
            items: [{ node: "d", text: { landed: true } }],
            applied: [],
          }
        : { status: "cancelled" },
    );
    expect(queue.pending).toBe(false);
    queue.destroy();
  }
  const answer = deferred<ApplyClickAnswer>();
  const queue = new ApplyClickQueue({
    node: "d",
    send: () => answer.promise,
    lookup: vi.fn(),
    changed() {},
  });
  const result = queue.enqueue(frozen("answered"));
  await flush();
  answer.resolve({
    status: "applied",
    commandId: "answered",
    items: [{ node: "d", text: { landed: true } }],
    applied: [],
  });
  await flush();
  queue.close();
  expect(await result).toEqual({
    status: "applied",
    commandId: "answered",
    items: [{ node: "d", text: { landed: true } }],
    applied: [],
  });
  queue.destroy();
});

const lost: Settlement[] = [{ rule: "left_out", items: ["d"], why: "purged" }];

it("one settled click in the middle removes only its contribution, answers its own caller and sends the next frozen click", async () => {
  const send = vi.fn(
    async (request: ApplyClick): Promise<ApplyClickAnswer> =>
      request.commandId === "second"
        ? {
            status: "applied",
            commandId: request.commandId,
            items: [{ node: "d", text: { landed: false, settled: lost } }],
            applied: [],
          }
        : {
            status: "applied",
            commandId: request.commandId,
            items: [{ node: "d", text: { landed: true } }],
            applied: [],
          },
  );
  const queue = new ApplyClickQueue({ node: "d", send, lookup: vi.fn(), changed() {} });
  queue.enqueue(frozen("first"));
  const second = queue.enqueue(frozen("second"));
  const third = queue.enqueue(frozen("third"));
  await flush();
  expect(await second).toEqual({
    status: "applied",
    commandId: "second",
    items: [{ node: "d", text: { landed: false, settled: lost } }],
    applied: [],
  });
  expect(send.mock.calls.map(([request]) => request.commandId)).toEqual([
    "first",
    "second",
    "third",
  ]);
  await expect(third).resolves.toEqual({
    status: "applied",
    commandId: "third",
    items: [{ node: "d", text: { landed: true } }],
    applied: [],
  });
  queue.destroy();
});
