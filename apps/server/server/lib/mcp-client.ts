/**
 * The process's one MCP client. Every request it makes to a writer's server goes through
 * `publicFetch`, which allows (`addressRefusal`) https on port 443 only, follows no redirect and dials through the public-address
 * dispatcher (the one import of it for MCP). A session is held per key
 * (`sessionKey`), and one account holds at most `MCP_SESSIONS_PER_ACCOUNT` of them: past that
 * the least recently used idle one closes, a session an edit left behind first.
 */

import { isIP } from "node:net";
import { MCP_SESSIONS_PER_ACCOUNT, mcpAddressProblem } from "@meridian/contracts/mcp";
import { createMcpClient, type McpClient, type McpEvent } from "@meridian-flow/runtime/mcp";
import { fetch as undiciFetch } from "undici";
import { isPublicAddress, publicAddressDispatcher } from "./public-address-dispatcher.js";

/**
 * Why Flow will never contact this address, or null. The one rule the settings API applies at
 * add and `publicFetch` applies to every request; a name that only resolves to a private address
 * is refused later by the dispatcher.
 */
export function addressRefusal(url: URL): string | null {
  const problem = mcpAddressProblem(url);
  if (problem === "not_https")
    return "Flow connects only to https addresses, so the address must start with https://.";
  if (problem === "not_port_443")
    return "Flow connects only to port 443, so take the port out of the address.";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (isIP(host) !== 0 && !isPublicAddress(host))
  )
    return `Flow connects only to public addresses, and ${host} is not one.`;
  return null;
}

const publicFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const refusal = addressRefusal(url);
  if (refusal) throw new Error(refusal);
  // Redirects are not followed: a hop could change the scheme or the port.
  const response = await undiciFetch(url, {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: publicAddressDispatcher,
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel();
    throw new Error(
      `The server redirected (HTTP ${response.status}); Flow does not follow redirects`,
    );
  }
  return response;
}) as unknown as typeof fetch;

/** One session per account, connection and settings version: an edit starts a new one in every process. */
export const sessionKey = (accountId: string, connectionId: string, settingsVersion: number) =>
  `${accountId}/${connectionId}/${settingsVersion}`;

export const parseSessionKey = (key: string) => {
  const [accountId = "", connectionId = "", version = "0"] = key.split("/");
  return { accountId, connectionId, version: Number(version) };
};

export function createProcessMcpClient(onEvent?: (event: McpEvent) => void): McpClient {
  const lastUse = new Map<string, number>();
  const busy = new Map<string, number>();
  let tick = 0;
  const touch = (key: string) => lastUse.set(key, ++tick);
  // A key with no session yet is not counted against the limit until its session starts.
  const touchIfOpen = (key: string) => lastUse.has(key) && touch(key);

  function enforceLimit(startedKey: string) {
    const { accountId } = parseSessionKey(startedKey);
    const own = [...lastUse.keys()].filter((key) => parseSessionKey(key).accountId === accountId);
    const newest = new Map<string, number>();
    for (const key of own) {
      const { connectionId, version } = parseSessionKey(key);
      newest.set(connectionId, Math.max(newest.get(connectionId) ?? 0, version));
    }
    const superseded = (key: string) => {
      const { connectionId, version } = parseSessionKey(key);
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
      onEvent?.(event);
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
