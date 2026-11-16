/**
 * The process's one MCP client. Every request it makes to a writer's server goes through
 * `publicFetch`, which allows https on port 443 only and dials through the public-address
 * dispatcher (the one import of it for MCP). A session is held per key
 * (`sessionKey`), and one account holds at most `MCP_SESSIONS_PER_ACCOUNT` of them: past that
 * the least recently used idle one closes, a session an edit left behind first.
 */
import { MCP_SESSIONS_PER_ACCOUNT } from "@meridian/contracts/mcp";
import { createMcpClient, type McpClient } from "@meridian-flow/runtime/mcp";
import { fetch as undiciFetch } from "undici";
import { publicAddressDispatcher } from "./public-address-dispatcher.js";

const publicFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.protocol !== "https:")
    throw new Error("Flow connects to https addresses only, so this address was not contacted");
  if (url.port !== "" && url.port !== "443")
    throw new Error("Flow connects to port 443 only, so this address was not contacted");
  // Redirects are not followed: a hop could change the scheme or the port.
  return undiciFetch(url, {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: publicAddressDispatcher,
    redirect: "manual",
  });
}) as unknown as typeof fetch;

/** One session per account, connection and settings version: an edit starts a new one in every process. */
export const sessionKey = (accountId: string, connectionId: string, settingsVersion: number) =>
  `${accountId}/${connectionId}/${settingsVersion}`;

const parseKey = (key: string) => {
  const [accountId = "", connectionId = "", version = "0"] = key.split("/");
  return { accountId, connectionId, version: Number(version) };
};

export function createProcessMcpClient(): McpClient {
  const lastUse = new Map<string, number>();
  const busy = new Map<string, number>();
  let tick = 0;
  const touch = (key: string) => lastUse.set(key, ++tick);
  // A key with no session yet is not counted against the limit until its session starts.
  const touchIfOpen = (key: string) => lastUse.has(key) && touch(key);

  function enforceLimit(startedKey: string) {
    const { accountId } = parseKey(startedKey);
    const own = [...lastUse.keys()].filter((key) => parseKey(key).accountId === accountId);
    const newest = new Map<string, number>();
    for (const key of own) {
      const { connectionId, version } = parseKey(key);
      newest.set(connectionId, Math.max(newest.get(connectionId) ?? 0, version));
    }
    const superseded = (key: string) => {
      const { connectionId, version } = parseKey(key);
      return version < (newest.get(connectionId) ?? 0);
    };
    const idle = own
      .filter((key) => key !== startedKey && !busy.get(key))
      .sort(
        (a, b) =>
          Number(superseded(b)) - Number(superseded(a)) ||
          (lastUse.get(a) ?? 0) - (lastUse.get(b) ?? 0),
      );
    // A call is never refused for the limit: with every session busy the account stays over it.
    for (let excess = own.length - MCP_SESSIONS_PER_ACCOUNT; excess > 0 && idle.length; excess--) {
      const key = idle.shift() as string;
      lastUse.delete(key);
      void client.close(key);
    }
  }

  const inner = createMcpClient({
    clientInfo: { name: "meridian-flow", version: "1" },
    fetch: publicFetch,
    onEvent(event) {
      if (event.type === "session_started") {
        touch(event.key);
        enforceLimit(event.key);
      } else if (event.type === "session_ended") {
        lastUse.delete(event.key);
        busy.delete(event.key);
      }
    },
  });

  const client: McpClient = {
    list(server, opts) {
      touchIfOpen(server.key);
      return inner.list(server, opts);
    },
    async call(server, call, opts) {
      touchIfOpen(server.key);
      busy.set(server.key, (busy.get(server.key) ?? 0) + 1);
      try {
        return await inner.call(server, call, opts);
      } finally {
        const left = (busy.get(server.key) ?? 1) - 1;
        if (left > 0) busy.set(server.key, left);
        else busy.delete(server.key);
      }
    },
    check: (server, opts) => inner.check(server, opts),
    close: (key) => inner.close(key),
  };
  return client;
}
