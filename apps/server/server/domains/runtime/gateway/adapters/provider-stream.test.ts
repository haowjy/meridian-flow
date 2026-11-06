/**
 * An abort ends a provider stream at once with what accumulated, even when the SDK ignores it.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - The envelope, not the attempt driver, builds the `end` for a stop
 */
import { describe, expect, it } from "vitest";
import type { GenerateResult, StreamEvent } from "../domain/index.js";
import { streamProvider } from "./provider-stream.js";

const START: Extract<StreamEvent, { type: "start" }> = { type: "start", model: "m", provider: "p" };

function run(open: () => Promise<AsyncIterable<string>>, signal: AbortSignal) {
  let text = "";
  const stream = streamProvider<string>({
    start: START,
    signal,
    open,
    events: function* (frame) {
      text += frame;
      yield { type: "text.delta", text: frame };
    },
    result: () =>
      ({
        content: text ? [{ type: "text", text }] : [],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "m",
        provider: "p",
      }) satisfies GenerateResult,
  })[Symbol.asyncIterator]();
  return stream;
}

describe("streamProvider abort", () => {
  it("ends with the text so far when the SDK hangs after output", async () => {
    const controller = new AbortController();
    const stream = run(
      async () =>
        (async function* () {
          yield "chapter twelve";
          await new Promise(() => {});
        })(),
      controller.signal,
    );
    await stream.next();
    await stream.next();
    const pending = stream.next();
    controller.abort();
    expect((await pending).value).toMatchObject({
      type: "end",
      result: { content: [{ type: "text", text: "chapter twelve" }] },
    });
  });

  it("ends with an empty result when open() never resolves", async () => {
    const controller = new AbortController();
    const stream = run(() => new Promise(() => {}), controller.signal);
    await stream.next();
    const pending = stream.next();
    controller.abort();
    expect((await pending).value).toMatchObject({ type: "end", result: { content: [] } });
  });
});
