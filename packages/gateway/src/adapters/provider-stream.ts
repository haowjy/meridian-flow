/**
 * The streaming envelope every provider adapter shares: `start`, open the SDK stream,
 * map each frame to canonical events, then `end`. Adapters pass closures over their own
 * accumulator, so this envelope knows nothing of provider wire shapes.
 *
 * An abort ends the stream at once with an `end` built from what accumulated, possibly
 * nothing, even when the SDK ignores the abort. That `end` is not success: `streamWithRetry`
 * owns what a stop or timeout means.
 */
import type { GenerateResult, StreamEvent } from "../domain/index.js";
import { mapProviderHttpError, type ProviderErrorPatterns } from "./provider-http-error.js";

const ABORTED = Symbol("aborted");

/** Closes an iterator without waiting on it: a hung SDK iterator must not block the exit. */
async function release(iterator: Promise<AsyncIterator<unknown> | undefined>): Promise<void> {
  // allSettled observes a failed open or close; nothing is waiting on either.
  await Promise.allSettled([iterator.then((it) => it?.return?.())]);
}

export async function* streamProvider<Frame>(spec: {
  start: Extract<StreamEvent, { type: "start" }>;
  signal: AbortSignal | undefined;
  errorPatterns?: Partial<ProviderErrorPatterns>;
  /** Reshapes an SDK error whose status, message or headers `mapProviderHttpError` can't read as is. */
  normalizeError?: (err: unknown) => unknown;
  open: () => Promise<AsyncIterable<Frame>>;
  events: (frame: Frame) => Iterable<StreamEvent>;
  result: () => GenerateResult;
}): AsyncIterable<StreamEvent> {
  yield spec.start;
  // After an abort the SDK owes nothing more: the accumulator already holds all there is, so an
  // abort ends here whether the SDK rejects, returns or hangs. A timeout aborts the same signal;
  // `streamWithRetry` tells the two apart.
  const signal = spec.signal;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    if (signal?.aborted) return resolve(ABORTED);
    onAbort = () => resolve(ABORTED);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  let frames: AsyncIterator<Frame> | undefined;
  try {
    const opening = spec.open();
    const opened = await Promise.race([opening, aborted]);
    if (opened === ABORTED) {
      void release(opening.then((stream) => stream[Symbol.asyncIterator]()));
    } else {
      frames = opened[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([frames.next(), aborted]);
        if (next === ABORTED || next.done) break;
        for (const event of spec.events(next.value)) {
          yield event;
          if (event.type === "error") return;
        }
      }
    }
  } catch (err) {
    if (!signal?.aborted) {
      yield {
        type: "error",
        ...mapProviderHttpError(spec.normalizeError?.(err) ?? err, spec.errorPatterns),
      };
      return;
    }
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    // Every exit closes the SDK stream, as `for await` did: error frame, consumer drop, abort.
    void release(Promise.resolve(frames));
  }
  yield { type: "end", result: spec.result() };
}
