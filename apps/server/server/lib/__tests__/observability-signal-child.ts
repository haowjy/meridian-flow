import { appendFileSync } from "node:fs";
import type { Gateway, StreamEvent } from "../../domains/runtime/gateway/index.js";
import { runtimeScenario } from "../../domains/runtime/loop/__tests__/runtime-harness.js";
import { getOrBindProcessObservability } from "../observability.js";
import { installProcessShutdownHooks } from "../process-shutdown.js";

const tracePath = process.argv.at(-1);
if (!tracePath) throw new Error("Missing shutdown trace path");
const record = (event: string) => appendFileSync(tracePath, `${event}\n`);
const keepAlive = setInterval(() => {}, 1_000);

const gateway: Gateway = {
  getDefaultModel: () => "gpt-4.1-mini",
  async *stream(request) {
    request.signal?.addEventListener(
      "abort",
      () => record(`abort:${String(request.signal?.reason)}`),
      { once: true },
    );
    yield { type: "text.delta", text: "partial" } satisfies StreamEvent;
    await new Promise<void>((resolve) => {
      if (request.signal?.aborted) resolve();
      else request.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    // Keep the signal handler in its bounded drain while the paid result settles.
    await new Promise((resolve) => setTimeout(resolve, 200));
    yield {
      type: "end",
      result: {
        content: [{ type: "text", text: "partial answer" }],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 10 },
        model: "gpt-4.1-mini",
        provider: "openai",
      },
    } satisfies StreamEvent;
  },
  async generate() {
    throw new Error("The shutdown fixture only streams");
  },
  async settleCancelledResult({ result }) {
    return result ? { result, persist: true } : null;
  },
};

let runtime!: Awaited<ReturnType<typeof runtimeScenario>>;
runtime = await runtimeScenario({
  gateway,
  runStarter: { start: (threadId) => runtime.startDrain(threadId) },
});
await runtime.send(runtime.thread.id, "A reply interrupted by shutdown");
await runtime.gatewaySignal.promise;

getOrBindProcessObservability(() => ({
  sink: {
    emit() {},
    emitBatch() {},
    async flush() {
      record("flush");
    },
  },
}));
const steps = [
  {
    stage: "application-drain" as const,
    callback: async () => {
      record("begin-shutdown");
      runtime.runner.beginShutdown();
      record("drain-start");
      const drained = await runtime.backgroundTasks.drain(5_000);
      const turns = await runtime.repos.turns.listByThread(runtime.thread.id);
      const reply = turns.find((turn) => turn.role === "assistant");
      const responses = reply ? await runtime.repos.modelResponses.listByTurn(reply.id) : [];
      const pending = await runtime.delivery.selectPending(runtime.thread.id);
      const reason =
        reply?.metadata && typeof reply.metadata === "object" && !Array.isArray(reply.metadata)
          ? reply.metadata.reason
          : undefined;
      record(`drain-settled:${drained}`);
      record(`settle-paid-response:${responses.length}`);
      record(`reply-error-shutdown:${reason}:${reply?.error}`);
      record(`acknowledge-adopted-message:${pending.length === 0}`);
      clearInterval(keepAlive);
    },
  },
];
installProcessShutdownHooks(
  getOrBindProcessObservability(() => {
    throw new Error("Process observability must already be bound");
  }).sink,
  steps,
);
process.stdout.write("ready\n");
