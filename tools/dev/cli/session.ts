/**
 * Authenticated session against this worktree's running dev stack: origin discovery,
 * dev-login cookie (memory only), and bounded JSON requests to the app's own API.
 */
import { execFileSync } from "node:child_process";
import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import path from "node:path";
import { portlessCa } from "../dev-readiness";
import { branchToPortlessPrefix } from "../portless-prefix";
import { resolveExpectedRouteUrls } from "../portless-routes";
import { CliError } from "./cli-error";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RequestOptions = { timeoutMs?: number; maxResponseBytes?: number };

export interface Session {
  readonly serverUrl: string;
  readonly cookie: string;
  readonly ca: string[] | undefined;
  request<T = unknown>(
    method: HttpMethod,
    requestPath: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T>;
}

type RawResponse = { status: number; headers: IncomingHttpHeaders; body: string };

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const STACK_HINT = "Start this worktree's stack with `pnpm dev`, then retry.";

export function rawRequest(input: {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
  ca?: string[];
  timeoutMs: number;
  maxResponseBytes: number;
}): Promise<RawResponse> {
  const url = new URL(input.url);
  const client = url.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      operation();
    };
    const request = client.request(
      url,
      {
        method: input.method,
        headers: {
          accept: "application/json",
          ...(input.body !== undefined
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(input.body)),
              }
            : {}),
          ...input.headers,
        },
        ...(url.protocol === "https:" && input.ca ? { ca: input.ca } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > input.maxResponseBytes) {
            request.destroy(
              new CliError(
                "http_error",
                `Response exceeded the ${input.maxResponseBytes}-byte limit`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          ),
        );
      },
    );
    const deadline = setTimeout(
      () =>
        request.destroy(
          new CliError("timeout", `${input.method} ${url.pathname} exceeded ${input.timeoutMs}ms`),
        ),
      input.timeoutMs,
    );
    request.on("error", (error) =>
      finish(() => reject(error instanceof CliError ? error : connectionError(url, error))),
    );
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

function connectionError(url: URL, error: Error): CliError {
  return new CliError("unavailable", `Cannot reach ${url.origin}: ${error.message}`, {
    hint: STACK_HINT,
  });
}

/** Maps a non-2xx API response onto the exit-code contract. */
export function httpError(method: string, requestPath: string, response: RawResponse): CliError {
  let message = response.body.slice(0, 400);
  let details: unknown;
  try {
    const parsed = JSON.parse(response.body) as { message?: unknown; statusMessage?: unknown };
    details = parsed;
    if (typeof parsed.message === "string") message = parsed.message;
    else if (typeof parsed.statusMessage === "string") message = parsed.statusMessage;
  } catch {}
  const summary = `${method} ${requestPath} → HTTP ${response.status}: ${message}`;
  if (response.status === 401) {
    return new CliError("unavailable", summary, {
      hint: "Dev login did not authenticate. Check WORKOS_DEV_AUTOLOGIN and the dev login credentials.",
      details,
    });
  }
  if (response.status === 404) return new CliError("not_found", summary, { details });
  if (response.status === 400 || response.status === 422) {
    return new CliError("usage", summary, { details });
  }
  return new CliError("http_error", summary, { details });
}

export function createSession(input: {
  serverUrl: string;
  cookie: string;
  ca: string[] | undefined;
}): Session {
  return {
    serverUrl: input.serverUrl,
    cookie: input.cookie,
    ca: input.ca,
    async request<T>(
      method: HttpMethod,
      requestPath: string,
      body?: unknown,
      options?: RequestOptions,
    ): Promise<T> {
      const response = await rawRequest({
        url: new URL(requestPath, input.serverUrl).toString(),
        method,
        headers: input.cookie ? { cookie: input.cookie } : {},
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ca: input.ca,
        timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxResponseBytes: options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      });
      if (response.status < 200 || response.status >= 300) {
        throw httpError(method, requestPath, response);
      }
      if (!response.body) return undefined as T;
      try {
        return JSON.parse(response.body) as T;
      } catch {
        return response.body as T;
      }
    },
  };
}

function sessionCookie(headers: IncomingHttpHeaders): string {
  const cookie = (headers["set-cookie"] ?? [])
    .map((entry) => entry.split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
  if (!cookie) {
    throw new CliError("unavailable", "Dev login did not return a session cookie", {
      hint: "Set WORKOS_DEV_AUTOLOGIN=1 with WORKOS_DEV_LOGIN_EMAIL/PASSWORD, then restart `pnpm dev`.",
    });
  }
  return cookie;
}

async function devLogin(appUrl: string, ca: string[] | undefined): Promise<string> {
  const response = await rawRequest({
    url: new URL("/api/auth/dev-login", appUrl).toString(),
    method: "GET",
    ca,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResponseBytes: 64 * 1024,
  });
  if (response.status !== 302) {
    throw new CliError(
      "unavailable",
      `Dev login failed with HTTP ${response.status}: ${response.body.slice(0, 200)}`,
      { hint: "Dev login needs WORKOS_DEV_AUTOLOGIN=1 and a non-production app." },
    );
  }
  return sessionCookie(response.headers);
}

function resolvePortlessOrigins(repoRoot: string): { app: string; server: string } {
  let output: string;
  try {
    output = execFileSync(path.join(repoRoot, "node_modules", ".bin", "portless"), ["list"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
  } catch {
    throw new CliError("unavailable", "Portless is not running", { hint: STACK_HINT });
  }
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  }).trim();
  const urls = resolveExpectedRouteUrls({
    output,
    mode: "local",
    worktreePrefix: branchToPortlessPrefix(branch),
  });
  if (!urls.app || !urls.server) {
    throw new CliError("unavailable", "This worktree's app/server routes are not running", {
      hint: STACK_HINT,
    });
  }
  return { app: urls.app, server: urls.server };
}

/**
 * MF_SERVER_URL (+ MF_COOKIE or MF_APP_URL) targets an explicit stack; otherwise the
 * current worktree's Portless routes are discovered and dev-login mints the cookie.
 */
export async function openSession(input: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<Session> {
  const ca = portlessCa();
  const explicitServer = input.env.MF_SERVER_URL?.trim();
  if (explicitServer) {
    const cookie =
      input.env.MF_COOKIE?.trim() ??
      (input.env.MF_APP_URL?.trim() ? await devLogin(input.env.MF_APP_URL.trim(), ca) : "");
    return createSession({ serverUrl: explicitServer, cookie, ca });
  }
  const origins = resolvePortlessOrigins(input.repoRoot);
  return createSession({ serverUrl: origins.server, cookie: await devLogin(origins.app, ca), ca });
}
