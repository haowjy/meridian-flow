/**
 * The streaming envelope every provider adapter shares: `start`, open the SDK stream,
 * map each frame to canonical events, then `end`. Adapters pass closures over their own
 * accumulator, so the driver knows nothing of provider wire shapes.
 *
 * After an abort, `end` carries whatever accumulated, possibly nothing, whether the SDK
 * swallowed the abort or threw it. That `end` is not success: `streamWithRetry` owns what
 * a stop or timeout means.
 */
import type { GenerateResult, StreamEvent } from "../domain/index.js";
import { mapProviderHttpError, type ProviderErrorPatterns } from "./provider-http-error.js";

export async function* streamProvider<Frame>(spec: {
  start: Extract<StreamEvent, { type: "start" }>;
  signal: AbortSignal | undefined;
  errorPatterns?: Partial<ProviderErrorPatterns>;
  open: () => Promise<AsyncIterable<Frame>>;
  events: (frame: Frame) => Iterable<StreamEvent>;
  result: () => GenerateResult;
}): AsyncIterable<StreamEvent> {
  yield spec.start;
  try {
    for await (const frame of await spec.open()) {
      for (const event of spec.events(frame)) {
        yield event;
        if (event.type === "error") return;
      }
    }
  } catch (err) {
    if (!spec.signal?.aborted) {
      yield { type: "error", ...mapProviderHttpError(err, spec.errorPatterns) };
      return;
    }
  }
  yield { type: "end", result: spec.result() };
}
