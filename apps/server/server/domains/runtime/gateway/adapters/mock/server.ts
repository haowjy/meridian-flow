/**
 * Mock OpenAI-compatible HTTP server: a local Chat Completions endpoint (stream
 * + non-stream) for tests and offline dev so the gateway can run without a real
 * provider. Owns the canned-response server; depends only on node:http.
 */
import { createServer, type Server } from "node:http";

/** OpenAI Chat Completions request body (subset). */
interface ChatCompletionRequest {
  model?: string;
  messages?: Array<{ role: string; content?: unknown }>;
  stream?: boolean;
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

function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const VERTICAL_SLICE_TRIGGER = "Phase 7 final gate";
const VERTICAL_SLICE_WRITE_PATH = "manuscript://chapter-1.md";

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

function hasWriteTool(body: ChatCompletionRequest): boolean {
  return body.tools?.some((tool) => tool.function?.name === "write") ?? false;
}

function hasFunctionTool(body: ChatCompletionRequest, name: string): boolean {
  return body.tools?.some((tool) => tool.function?.name === name) ?? false;
}

function wantsWriteToolCall(body: ChatCompletionRequest): boolean {
  if (!hasWriteTool(body)) return false;
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
  if (body.tools?.length) {
    const text = messageText(body.messages).toLowerCase();
    return text.includes("weather") || text.includes("tool");
  }
  return false;
}

function verticalSliceWriteContent(userText: string): string {
  return `# Chapter 1\n\nAcknowledged: ${userText}`;
}

function writeSse(res: import("node:http").ServerResponse, chunks: string[]): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const chunk of chunks) {
    res.write(chunk);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeSseLater(
  res: import("node:http").ServerResponse,
  chunks: string[],
  delayMs: number,
): void {
  const timer = setTimeout(() => {
    if (res.destroyed) return;
    writeSse(res, chunks);
  }, delayMs);
  timer.unref();
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

/** OpenRouter hard-cancel: partial stream with generation id but no usage chunk before abort. */
function writeOpenRouterHardCancelStream(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  model: string,
): void {
  const generationId = "gen-hard-cancel";
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(
    sseLine({
      id: generationId,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }],
    }),
  );
  const finish = () => {
    if (res.destroyed || res.writableEnded) return;
    res.end();
  };
  req.on("aborted", finish);
  req.on("close", finish);
}

function buildTextStreamChunks(id: string, model: string, text: string): string[] {
  const chunks: string[] = [];
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    const delta = i === 0 ? word : ` ${word}`;
    chunks.push(
      sseLine({
        id,
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      }),
    );
  }
  chunks.push(
    sseLine({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: words.length,
        total_tokens: 10 + words.length,
      },
    }),
  );
  return chunks;
}

function buildWriteToolCallStreamChunks(id: string, model: string, userText: string): string[] {
  const toolName = "write";
  const args = JSON.stringify({
    path: VERTICAL_SLICE_WRITE_PATH,
    content: verticalSliceWriteContent(userText),
  });
  return [
    sseLine({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_mock_write_1",
                type: "function",
                function: { name: toolName, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    sseLine({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: args } }],
          },
          finish_reason: null,
        },
      ],
    }),
    sseLine({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }),
  ];
}

function buildSingleToolCallStreamChunks(input: {
  id: string;
  model: string;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}): string[] {
  const args = JSON.stringify(input.args);
  return [
    sseLine({
      id: input.id,
      object: "chat.completion.chunk",
      model: input.model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: input.callId,
                type: "function",
                function: { name: input.toolName, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    sseLine({
      id: input.id,
      object: "chat.completion.chunk",
      model: input.model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: args } }],
          },
          finish_reason: null,
        },
      ],
    }),
    sseLine({
      id: input.id,
      object: "chat.completion.chunk",
      model: input.model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }),
  ];
}

function buildBackgroundWriterHelperSpawnChunks(
  id: string,
  model: string,
  userText: string,
): string[] {
  return buildSingleToolCallStreamChunks({
    id,
    model,
    callId: "call_mock_spawn_writer_helper_1",
    toolName: "spawn",
    args: {
      agent: "writer-helper",
      mode: "background",
      description: "Writer helper background check",
      prompt: `Check this request independently and return a concise writing-craft note: ${userText}`,
    },
  });
}

function buildReturnResultChunks(id: string, model: string): string[] {
  return buildSingleToolCallStreamChunks({
    id,
    model,
    callId: "call_mock_return_result_1",
    toolName: "return_result",
    args: {
      summary: "Writer-helper checked the request and recommends keeping the next beat concrete.",
    },
  });
}

function buildToolCallStreamChunks(id: string, model: string): string[] {
  const toolName = "get_weather";
  const args = JSON.stringify({ location: "San Francisco" });
  return [
    sseLine({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_mock_weather_1",
                type: "function",
                function: { name: toolName, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    sseLine({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: args } }],
          },
          finish_reason: null,
        },
      ],
    }),
    sseLine({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }),
  ];
}

/**
 * In-process OpenAI-compatible mock for `/v1/chat/completions` (SSE).
 * Exercises the real openai-compatible adapter pipeline in dev and tests.
 */
export function createMockOpenAICompatibleServer(): Promise<MockOpenAIServer> {
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

      requestCount += 1;

      try {
        const body = (await readJsonBody(req)) as ChatCompletionRequest;
        const id = "chatcmpl-mock-1";
        const model = body.model ?? "mock-llm-v1";

        if (!body.stream) {
          const text =
            wantsToolCall(body) ||
            wantsWriteToolCall(body) ||
            wantsBackgroundWriterHelperSpawn(body) ||
            wantsReturnResult(body)
              ? ""
              : mockAssistantText(body.messages);
          res.writeHead(200, { "Content-Type": "application/json" });
          if (wantsBackgroundWriterHelperSpawn(body)) {
            const userText = lastUserMessageText(body.messages);
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
                      content: null,
                      tool_calls: [
                        {
                          id: "call_mock_spawn_writer_helper_1",
                          type: "function",
                          function: {
                            name: "spawn",
                            arguments: JSON.stringify({
                              agent: "writer-helper",
                              mode: "background",
                              description: "Writer helper background check",
                              prompt: `Check this request independently and return a concise writing-craft note: ${userText}`,
                            }),
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
              }),
            );
            return;
          }
          if (wantsReturnResult(body)) {
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
                      content: null,
                      tool_calls: [
                        {
                          id: "call_mock_return_result_1",
                          type: "function",
                          function: {
                            name: "return_result",
                            arguments: JSON.stringify({
                              summary:
                                "Writer-helper checked the request and recommends keeping the next beat concrete.",
                            }),
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
              }),
            );
            return;
          }
          if (wantsWriteToolCall(body)) {
            const userText = lastUserMessageText(body.messages);
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
                      content: null,
                      tool_calls: [
                        {
                          id: "call_mock_write_1",
                          type: "function",
                          function: {
                            name: "write",
                            arguments: JSON.stringify({
                              path: VERTICAL_SLICE_WRITE_PATH,
                              content: verticalSliceWriteContent(userText),
                            }),
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
              }),
            );
            return;
          }
          if (wantsToolCall(body)) {
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
                      content: null,
                      tool_calls: [
                        {
                          id: "call_mock_weather_1",
                          type: "function",
                          function: {
                            name: "get_weather",
                            arguments: JSON.stringify({ location: "San Francisco" }),
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
              }),
            );
            return;
          }
          res.end(
            JSON.stringify({
              id,
              object: "chat.completion",
              model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: text },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }),
          );
          return;
        }

        if (messageText(body.messages).includes("openrouter hard cancel")) {
          writeOpenRouterHardCancelStream(req, res, model);
          return;
        }

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

        if (messageText(body.messages).includes("slow before output")) {
          writeSseLater(
            res,
            buildTextStreamChunks(id, model, mockAssistantText(body.messages)),
            200,
          );
          return;
        }

        if (messageText(body.messages).includes("slow after output")) {
          writeSlowAfterFirstChunk(res, id, model);
          return;
        }

        const chunks = wantsBackgroundWriterHelperSpawn(body)
          ? buildBackgroundWriterHelperSpawnChunks(id, model, lastUserMessageText(body.messages))
          : wantsReturnResult(body)
            ? buildReturnResultChunks(id, model)
            : wantsWriteToolCall(body)
              ? buildWriteToolCallStreamChunks(id, model, lastUserMessageText(body.messages))
              : wantsToolCall(body)
                ? buildToolCallStreamChunks(id, model)
                : buildTextStreamChunks(id, model, mockAssistantText(body.messages));
        writeSse(res, chunks);
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
