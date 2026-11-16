/**
 * Connection status: when a check runs, what it learns, and the writes it makes. The machine and
 * its races are in `.context/state-machines.md`.
 */
import type { McpConnectionStatus } from "@meridian/contracts/mcp";
import type { CallOutcome, McpClient, Server, Unreachable } from "@meridian-flow/runtime/mcp";
import type { ConnectionRow, ConnectionStore } from "../ports/connection-store.js";

/** Anything that reads a status starts a check when the last one ended longer ago than this. */
export const CHECK_INTERVAL_MS = 60_000;
const CHECK_TIMEOUT_MS = 10_000;
/** A server that failed a check gets one more try this much later before it counts as down. */
const SECOND_TRY_DELAY_MS = 3_000;

export type ServerLoad = { server: Server } | { problem: "unreadable_token" };

export interface ConnectionChecksDeps {
  store: ConnectionStore;
  client: McpClient;
  loadServer(row: ConnectionRow): Promise<ServerLoad>;
  /** The status moved: tell the account's open screens to ask again. */
  statusChanged(row: ConnectionRow): void;
  /** A background check broke (the database, not the server): log it, never throw into the reader. */
  failed(cause: unknown, row: ConnectionRow): void;
  now?: () => Date;
  secondTryDelayMs?: number;
}

type Learned = { status: McpConnectionStatus; reason: string | null } | "unchanged";

/**
 * A request Flow refused to make, or a redirect it will not follow, shows as a failed start whose
 * message is the refusal's (it crosses the client as text). Neither mends by trying again.
 */
const REFUSED_BY_FLOW = /connects only to|not a public address|does not follow redirects/i;

const isRefusedByFlow = (outcome: Unreachable) =>
  outcome.reason === "start_failed" && REFUSED_BY_FLOW.test(outcome.message);

/** A writer's words for why a check failed. */
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

/** Why a server wants sign-in, from what Flow sent it: no token, a token, or a token it could not open. */
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
    // A result that lost to a later-started one still ends this check.
    if (!written) await deps.store.markCheckFinished(row.id, row.settingsVersion, finishedAt);
    else if (
      row.statusVersion !== row.settingsVersion ||
      row.status !== learned.status ||
      row.statusReason !== learned.reason
    )
      deps.statusChanged(row);
  }

  /** Runs one check, joining one already running in this process for the same connection and version. */
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
    // A refused token does not mend by itself: only the writer's Try again or a new token checks it.
    if (row.status === "needs_sign_in") return false;
    return (
      !row.checkFinishedAt || now().getTime() - row.checkFinishedAt.getTime() > CHECK_INTERVAL_MS
    );
  };

  /** Starts a check in the background for each connection that is due, and does not wait. */
  function startDue(rows: readonly ConnectionRow[]): void {
    for (const row of rows)
      if (isDue(row)) void check(row).catch((cause) => deps.failed(cause, row));
  }

  return {
    check,
    startDue,
    /**
     * What a call learned: a reply from the server means it works, a 401 means the token is
     * refused, a session that could not be reached asks for a check, and any other failure is one
     * request's and says nothing about the connection.
     */
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

export type ConnectionChecks = ReturnType<typeof createConnectionChecks>;
