import { isIP } from "node:net";
import { MCP_SESSIONS_PER_ACCOUNT, mcpAddressProblem } from "@meridian/contracts/mcp";
import { createMcpClient, type McpClient, type McpEvent } from "@meridian-flow/runtime/mcp";
import {
  isPublicAddress,
  type PublicFetchPolicy,
  publicFetch,
} from "./public-address-dispatcher.js";

// The one SSRF rule, applied at add and on every request; a name that only resolves to a private address is refused later by the dispatcher
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

const MCP_FETCH: PublicFetchPolicy = {
  check(url) {
    const refusal = addressRefusal(url);
    if (refusal) throw new Error(refusal);
  },
  maxRedirects: 0,
  redirectRefusal: (status) =>
    new Error(`The server redirected (HTTP ${status}); Flow does not follow redirects`),
};

const mcpFetch = (async (input: string | URL | Request, init?: RequestInit) =>
  publicFetch(
    new URL(input instanceof Request ? input.url : input),
    MCP_FETCH,
    init as Parameters<typeof publicFetch>[2],
  )) as unknown as typeof fetch;

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
    for (let excess = own.length - MCP_SESSIONS_PER_ACCOUNT; excess > 0 && idle.length; excess--) {
      const key = idle.shift() as string;
      lastUse.delete(key);
      void client.close(key);
    }
  }

  const inner = createMcpClient({
    clientInfo: { name: "meridian-flow", version: "1" },
    fetch: mcpFetch,
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
