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

  it("closes the SDK iterator on every exit: abort, error frame, consumer drop", async () => {
    const scripted = (frames: string[], hang: boolean) => {
      const state = { returned: 0 };
      const iterable: AsyncIterable<string> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            const value = frames.shift();
            if (value !== undefined) return { done: false, value };
            return hang ? new Promise<never>(() => {}) : { done: true, value: undefined };
          },
          return: async () => {
            state.returned++;
            return { done: true, value: undefined };
          },
        }),
      };
      return { state, iterable };
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    const hung = scripted(["a"], true);
    const controller = new AbortController();
    const abortStream = run(async () => hung.iterable, controller.signal);
    await abortStream.next();
    await abortStream.next();
    const pending = abortStream.next();
    controller.abort();
    await pending;
    await settle();
    expect(hung.state.returned).toBe(1);

    const dropped = scripted(["a", "b"], false);
    const dropStream = run(async () => dropped.iterable, new AbortController().signal);
    await dropStream.next();
    await dropStream.next();
    await dropStream.return?.();
    await settle();
    expect(dropped.state.returned).toBe(1);

    const failing = scripted(["a"], false);
    let text = "";
    const errStream = streamProvider<string>({
      start: START,
      signal: new AbortController().signal,
      open: async () => failing.iterable,
      events: function* (frame) {
        text += frame;
        yield {
          type: "error",
          message: "boom",
          code: "provider_error",
          retryable: false,
        } as StreamEvent;
      },
      result: () => ({ content: [{ type: "text", text }] }) as unknown as GenerateResult,
    })[Symbol.asyncIterator]();
    await errStream.next();
    expect((await errStream.next()).value).toMatchObject({ type: "error" });
    expect((await errStream.next()).done).toBe(true);
    await settle();
    expect(failing.state.returned).toBe(1);
  });
});
