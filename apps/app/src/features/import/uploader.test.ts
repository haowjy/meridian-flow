import type { ImportEntryStatus } from "@meridian/contracts";
import { describe, expect, it } from "vitest";
import type { HeldFile } from "./manifest";
import { type UploadOutcome, UploadQueue } from "./uploader";

const held = (entryId: number, file = new File(["x"], `f${entryId}.md`)): HeldFile => ({
  entryId,
  rootId: 0,
  path: `f${entryId}.md`,
  file,
});
const answer = (entryId: number) => ({ entryId, state: "received" }) as ImportEntryStatus;

/** Resolves when the queue says every queued file has settled. */
function drained(build: (onIdle: () => void) => UploadQueue): Promise<void> {
  return new Promise((resolve) => build(resolve));
}

describe("UploadQueue", () => {
  it("fails only the file that fails when its batch is retried one at a time", async () => {
    const outcomes: UploadOutcome[] = [];
    await drained((onIdle) => {
      const queue = new UploadQueue({
        signal: new AbortController().signal,
        send: async (parts) => {
          if (parts.some((part) => part.entryId === 2)) throw new Error("injected 500");
          return { entries: parts.map((part) => answer(part.entryId)) };
        },
        onOutcome: (batch) => outcomes.push(...batch),
        onIdle,
      });
      queue.add([held(1), held(2), held(3)]);
      return queue;
    });
    expect(
      outcomes
        .filter((o) => o.kind === "answered")
        .map((o) => o.kind === "answered" && o.entry.entryId)
        .sort(),
    ).toEqual([1, 3]);
    expect(
      outcomes.filter((o) => o.kind === "failed").map((o) => o.kind === "failed" && o.entryId),
    ).toEqual([2]);
  });

  it("sends nothing more once its signal aborts", async () => {
    const sent: number[] = [];
    const controller = new AbortController();
    const queue = new UploadQueue({
      signal: controller.signal,
      send: async (parts) => {
        sent.push(...parts.map((part) => part.entryId));
        controller.abort();
        return { entries: parts.map((part) => answer(part.entryId)) };
      },
      onOutcome: () => {},
      onIdle: () => {},
    });
    const big = () => new File([new Uint8Array(9 * 1024 * 1024)], "big.bin");
    queue.add(Array.from({ length: 5 }, (_, i) => held(i, big())));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent.length).toBeLessThanOrEqual(3);
    expect(queue.add([held(9)])).toBe(0);
  });
});
