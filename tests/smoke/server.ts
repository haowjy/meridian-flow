import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import {
  createGatewayFromEnv,
  type Gateway,
  GatewayStreamError,
  type GenerateRequest,
  type StreamEvent,
} from "../../apps/server/server/domains/runtime/gateway/index.js";

import { loadRepoEnv } from "./load-env.js";

export interface SmokeServer {
  baseUrl: string;
  port: number;
  gateway: Gateway;
  providerIds: string[];
  defaultModel?: string;
  close: () => Promise<void>;
}

interface ErrorBody {
  error: { code: string; message: string };
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function httpStatusForErrorCode(code: string): number {
  switch (code) {
    case "invalid_request":
      return 400;
    case "auth_error":
      return 401;
    case "content_filtered":
      return 403;
    case "rate_limited":
      return 429;
    case "context_overflow":
      return 413;
    case "network_error":
    case "server_error":
    case "provider_error":
    case "malformed_response":
      return 502;
    default:
      return 500;
  }
}

function gatewayErrorBody(err: GatewayStreamError): ErrorBody {
  return { error: { code: err.code, message: err.message } };
}

function inferDefaultModel(gateway: Gateway): string | undefined {
  const models = gateway.listModels?.() ?? [];
  return (
    models.find((m) => m.id === "deepseek-chat")?.id ??
    models.find((m) => m.id === "mock-llm-v1")?.id ??
    models[0]?.id
  );
}

function providerIdsFromGateway(gateway: Gateway): string[] {
  const models = gateway.listModels?.() ?? [];
  return [...new Set(models.map((m) => m.provider))];
}

function isGenerateRequest(body: unknown): body is GenerateRequest {
  if (!body || typeof body !== "object") return false;
  const messages = (body as GenerateRequest).messages;
  return Array.isArray(messages) && messages.length > 0;
}

async function handleGenerate(gateway: Gateway, body: unknown, res: ServerResponse): Promise<void> {
  if (!isGenerateRequest(body)) {
    sendJson(res, 400, {
      error: { code: "invalid_request", message: "Expected { messages: Message[] }" },
    });
    return;
  }

  try {
    const result = await gateway.generate(body);
    sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof GatewayStreamError) {
      sendJson(res, httpStatusForErrorCode(err.code), gatewayErrorBody(err));
      return;
    }
    sendJson(res, 500, {
      error: {
        code: "provider_error",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

async function handleStream(gateway: Gateway, body: unknown, res: ServerResponse): Promise<void> {
  if (!isGenerateRequest(body)) {
    sendJson(res, 400, {
      error: { code: "invalid_request", message: "Expected { messages: Message[] }" },
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  try {
    for await (const event of gateway.stream(body)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === "end" || event.type === "error") break;
    }
  } catch (err) {
    const errorEvent: StreamEvent = {
      type: "error",
      code: "provider_error",
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
    };
    res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
  } finally {
    res.end();
  }
}

function createRequestHandler(state: {
  gateway: Gateway;
  providerIds: string[];
  defaultModel?: string;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        status: "ok",
        providers: state.providerIds,
        defaultModel: state.defaultModel,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/generate") {
      void readJsonBody(req)
        .then((body) => handleGenerate(state.gateway, body, res))
        .catch((err: unknown) => {
          sendJson(res, 400, {
            error: {
              code: "invalid_request",
              message: err instanceof Error ? err.message : "Invalid JSON body",
            },
          });
        });
      return;
    }

    if (req.method === "POST" && url.pathname === "/stream") {
      void readJsonBody(req)
        .then((body) => handleStream(state.gateway, body, res))
        .catch((err: unknown) => {
          sendJson(res, 400, {
            error: {
              code: "invalid_request",
              message: err instanceof Error ? err.message : "Invalid JSON body",
            },
          });
        });
      return;
    }

    sendJson(res, 404, {
      error: { code: "invalid_request", message: `Not found: ${url.pathname}` },
    });
  };
}

export async function startSmokeServer(options?: { port?: number }): Promise<SmokeServer> {
  loadRepoEnv();

  const { gateway, cleanup } = await createGatewayFromEnv({
    MODEL_PROVIDER: process.env.MODEL_PROVIDER as
      | "mock"
      | "anthropic"
      | "openai"
      | "auto"
      | undefined,
    MODEL_CALL_TIMEOUT_MS: process.env.MODEL_CALL_TIMEOUT_MS,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  });

  const providerIds = providerIdsFromGateway(gateway);
  const defaultModel = inferDefaultModel(gateway);

  const port = options?.port ?? (process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 0);
  let httpServer: Server | undefined;

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      if (!httpServer) {
        resolve();
        return;
      }
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    if (cleanup) await cleanup();
  };

  const handler = createRequestHandler({ gateway, providerIds, defaultModel });

  return new Promise((resolve, reject) => {
    httpServer = createServer(handler);
    httpServer.on("error", reject);
    httpServer.listen(port, () => {
      const address = httpServer?.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind smoke server"));
        return;
      }
      const boundPort = address.port;
      const baseUrl = `http://127.0.0.1:${boundPort}`;
      console.log(`model-gateway smoke server listening at ${baseUrl}`);
      console.log(`  providers: ${providerIds.join(", ") || "(none)"}`);
      console.log(`  defaultModel: ${defaultModel ?? "(unset)"}`);
      resolve({ baseUrl, port: boundPort, gateway, providerIds, defaultModel, close });
    });
  });
}

async function runStandalone(): Promise<void> {
  const server = await startSmokeServer();
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — shutting down smoke server`);
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  runStandalone().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
