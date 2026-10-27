/** A response timeout must not free capacity while an uncancellable object put still runs. */
import { afterEach, expect, it, vi } from "vitest";
import { createImportAdmission, inReceiveScope } from "./receive-admission.js";

afterEach(() => vi.useRealTimers());
it("holds admission after timeout until execution settles, with an aborted commit signal", async () => {
  vi.useFakeTimers();
  const admission = createImportAdmission(1);
  let finishPut!: () => void;
  const put = new Promise<void>((resolve) => {
    finishPut = resolve;
  });
  let committed = false;
  let pulses = 0;
  const result = inReceiveScope(
    {
      importId: "import",
      admission,
      authorize: async () => {},
      pulse: async () => {
        pulses++;
      },
      reportError: (cause) => {
        throw cause;
      },
    },
    async (_, signal) => {
      await put;
      signal.throwIfAborted();
      committed = true;
    },
  ).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
  expect(await result).toMatchObject({ statusCode: 408, code: "import_busy" });
  expect(admission.enter("import")).toBeNull();
  const stoppedAt = pulses;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(pulses).toBe(stoppedAt);
  finishPut();
  await vi.advanceTimersByTimeAsync(0);
  expect(committed).toBe(false);
  const release = admission.enter("import");
  expect(release).not.toBeNull();
  release?.();
});
