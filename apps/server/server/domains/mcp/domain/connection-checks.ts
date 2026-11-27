import type { McpConnectionStatus } from "@meridian/contracts/mcp";
import type { CallOutcome, McpClient, Server, Unreachable } from "@meridian-flow/runtime/mcp";
import type { ConnectionRow, ConnectionStore } from "../ports/connection-store.js";

export const CHECK_INTERVAL_MS = 60_000;
const CHECK_TIMEOUT_MS = 10_000;
const SECOND_TRY_DELAY_MS = 3_000;

export type ServerLoad = { server: Server } | { problem: "unreadable_token" };

export interface ConnectionChecksDeps {
  store: ConnectionStore;
  client: McpClient;
  loadServer(row: ConnectionRow): Promise<ServerLoad>;
  statusChanged(row: ConnectionRow): void;
  failed(cause: unknown, row: ConnectionRow): void;
  now?: () => Date;
  secondTryDelayMs?: number;
}

type Learned = { status: McpConnectionStatus; reason: string | null } | "unchanged";

const REFUSED_BY_FLOW = /connects only to|not a public address|does not follow redirects/i;

const isRefusedByFlow = (outcome: Unreachable) =>
  outcome.reason === "start_failed" && REFUSED_BY_FLOW.test(outcome.message);

function reasonText(outcome: Unreachable): string {
  switch (outcome.reason) {
    case "start_failed":
      if (/does not follow redirects/i.test(outcome.message))
        return "The server redirected. Flow doesn't follow redirects.";
      return REFUSED_BY_FLOW.test(outcome.message)
        ? "Flow connects only to public https addresses on port 443."
        : "Flow could not connect to the server.";
    case "connect_timeout":
    case "call_timeout":
      return "The server took too long to answer.";
    case "disconnected":
      return "The connection to the server dropped.";
    case "server_error":
      return `The server returned an error${outcome.httpStatus ? ` (HTTP ${outcome.httpStatus})` : ""}.`;
    case "bad_reply":
      return "The address did not answer like an MCP server.";
    case "forbidden":
      return "The server refused the request (HTTP 403).";
    case "unauthorized":
      return "The server refused the request (HTTP 401).";
    case "rate_limited":
      return "The server is limiting requests.";
  }
}

function signInReason(loaded: ServerLoad): string {
  if ("problem" in loaded) return "The saved token could not be read. Enter it again.";
  return "auth" in loaded.server.spec
    ? "The server refused the token."
    : "The server needs a token.";
}

export function createConnectionChecks(deps: ConnectionChecksDeps) {
  const now = deps.now ?? (() => new Date());
  const running = new Map<string, Promise<void>>();

  async function learn(loaded: ServerLoad): Promise<Learned | "aborted"> {
    if ("problem" in loaded) return { status: "needs_sign_in", reason: signInReason(loaded) };
    let outcome = await deps.client.check(loaded.server, { timeoutMs: CHECK_TIMEOUT_MS });
    if (
      outcome.kind === "unreachable" &&
      outcome.reason !== "unauthorized" &&
      outcome.reason !== "rate_limited" &&
      !isRefusedByFlow(outcome)
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, deps.secondTryDelayMs ?? SECOND_TRY_DELAY_MS),
      );
      outcome = await deps.client.check(loaded.server, { timeoutMs: CHECK_TIMEOUT_MS });
    }
    if (outcome.kind === "aborted") return "aborted";
    if (outcome.kind === "reachable") return { status: "connected", reason: null };
    if (outcome.reason === "unauthorized")
      return { status: "needs_sign_in", reason: signInReason(loaded) };
    if (outcome.reason === "rate_limited") return "unchanged";
    return { status: "unreachable", reason: reasonText(outcome) };
  }

  async function store(row: ConnectionRow, startedAt: Date, learned: Learned) {
    const finishedAt = now();
    if (learned === "unchanged") {
      await deps.store.markCheckFinished(row.id, row.settingsVersion, finishedAt);
      return;
    }
    const written = await deps.store.writeStatus({
      connectionId: row.id,
      version: row.settingsVersion,
      startedAt,
      status: learned.status,
      reason: learned.reason,
      finishedAt,
    });
    if (!written) await deps.store.markCheckFinished(row.id, row.settingsVersion, finishedAt);
    else if (
      row.statusVersion !== row.settingsVersion ||
      row.status !== learned.status ||
      row.statusReason !== learned.reason
    )
      deps.statusChanged(row);
  }

  function check(row: ConnectionRow): Promise<void> {
    const key = `${row.id}/${row.settingsVersion}`;
    const joined = running.get(key);
    if (joined) return joined;
    const startedAt = now();
    const run = (async () => {
      const learned = await learn(await deps.loadServer(row));
      if (learned !== "aborted") await store(row, startedAt, learned);
    })().finally(() => running.delete(key));
    running.set(key, run);
    return run;
  }

  const isDue = (row: ConnectionRow) => {
    if (row.deletedAt) return false;
    if (row.statusVersion !== row.settingsVersion || row.status === null) return true;
    if (row.status === "needs_sign_in") return false;
    return (
      !row.checkFinishedAt || now().getTime() - row.checkFinishedAt.getTime() > CHECK_INTERVAL_MS
    );
  };

  function startDue(rows: readonly ConnectionRow[]): void {
    for (const row of rows)
      if (isDue(row)) void check(row).catch((cause) => deps.failed(cause, row));
  }

  return {
    check,
    startDue,
    async recordCall(
      row: ConnectionRow,
      call: { startedAt: Date; loaded: ServerLoad },
      outcome: CallOutcome,
    ): Promise<void> {
      let learned: Learned = "unchanged";
      if (
        outcome.kind === "answered" ||
        outcome.kind === "rejected" ||
        outcome.kind === "too_large"
      )
        learned = { status: "connected", reason: null };
      else if (outcome.kind === "unreachable" && outcome.reason === "unauthorized")
        learned = { status: "needs_sign_in", reason: signInReason(call.loaded) };
      else if (
        outcome.kind === "unreachable" &&
        (outcome.reason === "start_failed" ||
          outcome.reason === "connect_timeout" ||
          outcome.reason === "disconnected")
      ) {
        startDue([row]);
        return;
      }
      if (learned === "unchanged") return;
      const written = await deps.store.writeStatus({
        connectionId: row.id,
        version: row.settingsVersion,
        startedAt: call.startedAt,
        status: learned.status,
        reason: learned.reason,
        finishedAt: now(),
      });
      if (written && (row.status !== learned.status || row.statusVersion !== row.settingsVersion))
        deps.statusChanged(row);
    },
  };
}
