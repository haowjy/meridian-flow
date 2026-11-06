/** Normal mock responses: resolve content once, then serialize the same response as JSON or paced SSE. */
import type { ServerResponse } from "node:http";
import type { MockModelStep } from "@meridian/contracts/protocol";
import { MOCK_SAMPLES } from "./samples.js";

const LOREM_WORDS =
  "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat".split(
    " ",
  );

function resolveResponse(step: MockModelStep, requestCount: number, promptTokens: number) {
  const sample = step.sample ? MOCK_SAMPLES[step.sample] : undefined;
  let text = step.text ?? sample?.text ?? "";
  if (step.lorem) {
    const paragraphSize = step.lorem.wordsPerParagraph ?? 80;
    const words: string[] = [];
    for (let i = 0; i < step.lorem.words; i++) {
      const separator = i === 0 ? "" : i % paragraphSize === 0 ? ".\n\n" : " ";
      words.push(separator + LOREM_WORDS[i % LOREM_WORDS.length]);
    }
    text = `${words.join("")}.`;
  } else if (step.repeat !== undefined) {
    text = Array.from({ length: step.repeat }, () => text).join("\n\n");
  }
  const reasoning = step.reasoning ?? sample?.reasoning ?? "";
  const toolCalls = (step.toolCalls ?? []).map((call, index) => ({
    id: `call_mock_${requestCount}_${index}`,
    type: "function" as const,
    function: { name: call.name, arguments: call.rawArgs ?? JSON.stringify(call.args ?? {}) },
  }));
  const reasoningTokens = Math.ceil(Buffer.byteLength(reasoning, "utf8") / 3);
  const outputTokens = Math.max(
    1,
    reasoningTokens +
      Math.ceil(
        Buffer.byteLength(
          text + toolCalls.map((call) => call.function.name + call.function.arguments).join(""),
          "utf8",
        ) / 3,
      ),
  );
  return {
    text,
    reasoning,
    toolCalls,
    finishReason: step.finishReason ?? (toolCalls.length ? "tool_calls" : "stop"),
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: outputTokens,
      total_tokens: promptTokens + outputTokens,
      ...(reasoningTokens
        ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } }
        : {}),
    },
  };
}

/** Code points keep surrogate pairs intact, including when chunkSize is one. */
function* fragments(text: string, size: number): Generator<string> {
  let fragment = "";
  let count = 0;
  for (const character of text) {
    fragment += character;
    if (++count === size) {
      yield fragment;
      fragment = "";
      count = 0;
    }
  }
  if (fragment) yield fragment;
}

function* responseChunks(
  id: string,
  model: string,
  response: ReturnType<typeof resolveResponse>,
  chunkSize: number,
): Generator<string> {
  const chunk = (delta: unknown, finishReason: string | null = null, usage?: unknown) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    })}\n\n`;
  for (const text of fragments(response.reasoning, chunkSize)) {
    yield chunk({ reasoning_content: text });
  }
  for (const text of fragments(response.text, chunkSize)) yield chunk({ content: text });
  for (const [index, call] of response.toolCalls.entries()) {
    yield chunk({
      tool_calls: [{ index, ...call, function: { name: call.function.name, arguments: "" } }],
    });
    for (const args of fragments(call.function.arguments, chunkSize)) {
      yield chunk({ tool_calls: [{ index, function: { arguments: args } }] });
    }
  }
  yield chunk({}, response.finishReason, response.usage);
}

export function writeMockResponse(
  res: ServerResponse,
  input: {
    id: string;
    model: string;
    stream: boolean;
    step: MockModelStep;
    requestCount: number;
    promptTokens: number;
  },
): void {
  const { id, model, step } = input;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chunks: Generator<string>;
  const cleanup = () => {
    clearTimeout(timer);
    res.off("drain", scheduleNext);
    res.off("close", cleanup);
    chunks?.return(undefined);
  };
  res.once("close", cleanup);

  function scheduleNext() {
    if (res.destroyed) return;
    if (step.chunkDelayMs) timer = setTimeout(pump, step.chunkDelayMs).unref();
    else pump();
  }

  function pump() {
    while (!res.destroyed) {
      const next = chunks.next();
      if (next.done) {
        res.end("data: [DONE]\n\n");
        return;
      }
      if (!res.write(next.value)) {
        // Generate only as the consumer drains, including unpaced large responses.
        res.once("drain", scheduleNext);
        return;
      }
      if (step.chunkDelayMs) {
        scheduleNext();
        return;
      }
    }
  }

  const begin = () => {
    if (res.destroyed) return;
    if (step.error) {
      res.writeHead(step.error.status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: step.error.message, type: "mock_script_error" } }),
      );
      return;
    }
    const response = resolveResponse(step, input.requestCount, input.promptTokens);
    if (!input.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: response.text || null,
                ...(response.reasoning ? { reasoning_content: response.reasoning } : {}),
                ...(response.toolCalls.length ? { tool_calls: response.toolCalls } : {}),
              },
              finish_reason: response.finishReason,
            },
          ],
          usage: response.usage,
        }),
      );
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    chunks = responseChunks(id, model, response, step.chunkSize ?? 24);
    pump();
  };
  if (step.delayMs) timer = setTimeout(begin, step.delayMs).unref();
  else begin();
}
