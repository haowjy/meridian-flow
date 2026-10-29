/**
 * Mock OpenAI-compatible HTTP server: a local Chat Completions endpoint (stream
 * + non-stream) for tests and offline dev so the gateway can run without a real
 * provider. Owns the canned-response server and request-derived mock usage.
 *
 * Write tool scripting (optional, for gate probes — does not change default
 * behavior unless present in the user message that triggers a write):
 *   `[[write <uri>]]` — target `<uri>` instead of `manuscript://Chapter 1`
 *   `[[write <uri> overwrite]]` — same with `overwrite: true` on create
 * A user message must include the mock's write trigger before these directives apply.
 *
 * Scripted replies (dev CLI `./mf mock script` / `send --mock`): when a
 * `MockScriptQueue` is supplied, a queued step answers the call before any of
 * the trigger-phrase behaviors below.
 */
import { createServer, type Server } from "node:http";
import type { MockModelDefaultResponse, MockModelStep } from "@meridian/contracts/protocol";
import { writeMockResponse } from "./response.js";
import type { MockScriptQueue } from "./script-queue.js";
import { parseWriteDirective } from "./write-directive.js";

/** OpenAI Chat Completions request body (subset). */
interface ChatCompletionRequest {
  model?: string;
  messages?: Array<{ role: string; content?: unknown }>;
  stream?: boolean;
  response_format?: unknown;
  tools?: Array<{ type: string; function?: { name: string } }>;
}

export interface MockOpenAIServer {
  baseUrl: string;
  port: number;
  requestCount: () => number;
  close: () => Promise<void>;
}

function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// Match the planner's three-byte heuristic on the wire input, not transport options.
// This is synthetic usage, but must grow with history so compaction probes stay reachable.
function inputTokens(body: ChatCompletionRequest): number {
  return Math.ceil(
    Buffer.byteLength(
      JSON.stringify({
        messages: body.messages ?? [],
        tools: body.tools ?? [],
        responseFormat: body.response_format ?? null,
      }),
      "utf8",
    ) / 3,
  );
}

function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const VERTICAL_SLICE_TRIGGER = "Phase 7 final gate";
const VERTICAL_SLICE_WRITE_PATH = "manuscript://Chapter 1";

function messageContentText(message: { role?: string; content?: unknown } | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "object" && part !== null && "text" in part) {
          return String((part as { text?: string }).text ?? "");
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

function messageText(messages: ChatCompletionRequest["messages"]): string {
  if (!messages?.length) return "";
  return messageContentText(messages[messages.length - 1]);
}

function lastUserMessageText(messages: ChatCompletionRequest["messages"]): string {
  if (!messages?.length) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      return messageContentText(messages[i]);
    }
  }
  return "";
}

function lastMessageRole(messages: ChatCompletionRequest["messages"]): string | undefined {
  if (!messages?.length) return undefined;
  return messages[messages.length - 1]?.role;
}

function mockAssistantText(messages: ChatCompletionRequest["messages"]): string {
  const userText = lastUserMessageText(messages);
  if (!userText) return "Acknowledged: (empty)";
  return `Acknowledged: ${userText}`;
}

function hasFunctionTool(body: ChatCompletionRequest, name: string): boolean {
  return body.tools?.some((tool) => tool.function?.name === name) ?? false;
}

function wantsWriteToolCall(body: ChatCompletionRequest): boolean {
  if (!hasFunctionTool(body, "write")) return false;
  const userText = lastUserMessageText(body.messages);
  if (!userText.includes(VERTICAL_SLICE_TRIGGER)) return false;
  return lastMessageRole(body.messages) !== "tool";
}

function wantsBackgroundWriterHelperSpawn(body: ChatCompletionRequest): boolean {
  if (!hasFunctionTool(body, "spawn")) return false;
  if (lastMessageRole(body.messages) === "tool") return false;
  const userText = lastUserMessageText(body.messages).toLowerCase();
  return userText.includes("background") && userText.includes("writer-helper");
}

function wantsReturnResult(body: ChatCompletionRequest): boolean {
  if (!hasFunctionTool(body, "return_result")) return false;
  if (lastMessageRole(body.messages) === "tool") return false;
  return lastUserMessageText(body.messages).length > 0;
}

function wantsToolCall(body: ChatCompletionRequest): boolean {
  if (!hasFunctionTool(body, "get_weather") || lastMessageRole(body.messages) === "tool")
    return false;
  const text = lastUserMessageText(body.messages).toLowerCase();
  return text.includes("weather") || text.includes("tool");
}

function verticalSliceWriteContent(userText: string): string {
  return `# Chapter 1\n\nAcknowledged: ${userText}`;
}

function writeSlowAfterFirstChunk(
  res: import("node:http").ServerResponse,
  id: string,
  model: string,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(
    sseLine({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
    }),
  );
  const timer = setTimeout(() => {
    if (res.destroyed) return;
    res.write("data: [DONE]\n\n");
    res.end();
  }, 200);
  timer.unref();
}

/** Streams partial output then ignores abort — gateway drain must time out. */
function writeHangCancelDrainStream(
  res: import("node:http").ServerResponse,
  id: string,
  model: string,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(
    sseLine({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
    }),
  );
}

/** Streams partial output + usage, then stalls until the client aborts the request. */
function writeCancelBillingStream(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  id: string,
  model: string,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(
    sseLine({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
    }),
  );
  res.write(
    sseLine({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: null }],
      usage: {
        prompt_tokens: 500_000,
        completion_tokens: 500_000,
        total_tokens: 1_000_000,
      },
    }),
  );
  const finish = () => {
    if (res.destroyed || res.writableEnded) return;
    res.end();
  };
  req.on("aborted", finish);
  req.on("close", finish);
}

function selectResponse(body: ChatCompletionRequest): MockModelStep | undefined {
  const userText = lastUserMessageText(body.messages);
  if (wantsBackgroundWriterHelperSpawn(body)) {
    return {
      toolCalls: [
        {
          name: "spawn",
          args: {
            agent: "writer-helper",
            mode: "background",
            name: "Writer helper background check",
            prompt: `Check this request independently and return a concise writing-craft note: ${userText}`,
          },
        },
      ],
    };
  }
  if (wantsReturnResult(body)) {
    return {
      toolCalls: [
        {
          name: "return_result",
          args: {
            summary:
              "Writer-helper checked the request and recommends keeping the next beat concrete.",
          },
        },
      ],
    };
  }
  if (wantsWriteToolCall(body)) {
    const directive = parseWriteDirective(userText);
    return {
      toolCalls: [
        {
          name: "write",
          args: {
            command: "create",
            path: directive?.path ?? VERTICAL_SLICE_WRITE_PATH,
            content: verticalSliceWriteContent(userText),
            ...(directive?.overwrite ? { overwrite: true } : {}),
          },
        },
      ],
    };
  }
  if (wantsToolCall(body)) {
    return { toolCalls: [{ name: "get_weather", args: { location: "San Francisco" } }] };
  }
  return undefined;
}

/**
 * In-process OpenAI-compatible mock for `/v1/chat/completions` (SSE).
 * Exercises the real openai-compatible adapter pipeline in dev and tests.
 */
export function createMockOpenAICompatibleServer(options?: {
  script?: MockScriptQueue;
  defaultResponse?: MockModelDefaultResponse;
}): Promise<MockOpenAIServer> {
  return new Promise((resolve, reject) => {
    let requestCount = 0;
    const server: Server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      const requestNumber = ++requestCount;

      try {
        const body = (await readJsonBody(req)) as ChatCompletionRequest;
        const promptTokens = inputTokens(body);
        const id = `chatcmpl-mock-${requestNumber}`;
        const model = body.model ?? "mock-llm-v1";
        const scripted = options?.script?.take(lastUserMessageText(body.messages));
        if (scripted) {
          writeMockResponse(res, {
            id,
            model,
            stream: body.stream === true,
            step: scripted,
            requestCount: requestNumber,
            promptTokens,
          });
          return;
        }

        if (body.stream) {
          if (messageText(body.messages).includes("hang cancel drain")) {
            writeHangCancelDrainStream(res, id, model);
            return;
          }

          if (messageText(body.messages).includes("cancel billing")) {
            writeCancelBillingStream(req, res, id, model);
            return;
          }

          if (messageText(body.messages).includes("midstream disconnect")) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(
              sseLine({
                id,
                object: "chat.completion.chunk",
                model,
                choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
              }),
            );
            res.write("data: {not-json}\n\n");
            res.end();
            return;
          }

          if (messageText(body.messages).includes("slow after output")) {
            writeSlowAfterFirstChunk(res, id, model);
            return;
          }
        }
        const step =
          body.stream && messageText(body.messages).includes("slow before output")
            ? { text: mockAssistantText(body.messages), delayMs: 200 }
            : (selectResponse(body) ?? options?.defaultResponse ?? { sample: "scene" });
        writeMockResponse(res, {
          id,
          model,
          stream: body.stream === true,
          step,
          requestCount: requestNumber,
          promptTokens,
        });
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("mock server failed to bind"));
        return;
      }
      resolve({
        port: addr.port,
        baseUrl: `http://127.0.0.1:${addr.port}/v1`,
        requestCount: () => requestCount,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          }),
      });
    });
  });
}
