/** Phase 0 criteria 1-2 client probe against throwaway Nitro /ws/yjs-spike route. */
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";

const uncaught: string[] = [];
process.on("uncaughtException", (error) => {
  uncaught.push(String(error));
});
process.on("unhandledRejection", (error) => {
  uncaught.push(String(error));
});

const baseUrl = process.env.SPIKE_WS_URL;
if (!baseUrl) throw new Error("Set SPIKE_WS_URL, e.g. wss://server.<scope>.localhost/ws/yjs-spike");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function text(doc: Y.Doc) {
  return doc.getText("body").toString();
}

function makeProvider(
  name: string,
  opts: { query?: string; token?: string | null; maxAttempts?: number } = {},
) {
  const doc = new Y.Doc();
  const events: string[] = [];
  const url = `${baseUrl}${opts.query ?? ""}`;
  const provider = new HocuspocusProvider({
    url,
    name,
    document: doc,
    WebSocketPolyfill: WebSocket,
    token: opts.token ?? null,
    delay: 100,
    minDelay: 100,
    initialDelay: 0,
    maxAttempts: opts.maxAttempts ?? 3,
    messageReconnectTimeout: 5000,
    onOpen: () => events.push("open"),
    onConnect: () => events.push("connect"),
    onAuthenticated: ({ scope }) => events.push(`authenticated:${scope}`),
    onAuthenticationFailed: ({ reason }) => events.push(`authenticationFailed:${reason}`),
    onSynced: () => events.push("synced"),
    onClose: ({ event }) => events.push(`close:${event.code}:${event.reason}`),
    onDisconnect: ({ event }) => events.push(`disconnect:${event.code}:${event.reason}`),
    onStatus: ({ status }) => events.push(`status:${status}`),
  });
  return { doc, provider, events, url };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function roundTrip() {
  const a = makeProvider("phase0-roundtrip", { query: "?uid=phase0-cookie-user" });
  const b = makeProvider("phase0-roundtrip", { query: "?uid=phase0-cookie-user" });
  await waitFor(
    () => a.events.includes("synced") && b.events.includes("synced"),
    "both providers synced",
  );
  a.doc.getText("body").insert(0, "hello-from-a");
  await waitFor(() => text(b.doc) === "hello-from-a", "client B receives A edit");
  b.doc.getText("body").insert(text(b.doc).length, "+b");
  await waitFor(() => text(a.doc) === "hello-from-a+b", "client A receives B edit");
  console.log(
    "CRITERION1",
    JSON.stringify({
      aText: text(a.doc),
      bText: text(b.doc),
      aEvents: a.events,
      bEvents: b.events,
    }),
  );
  a.provider.destroy();
  b.provider.destroy();
  await sleep(100);
}

async function auth() {
  const cookieOnly = makeProvider("phase0-auth-cookie", {
    query: "?uid=phase0-cookie-user",
    token: null,
  });
  await waitFor(
    () => cookieOnly.events.some((e) => e.startsWith("authenticated")),
    "cookie-only authenticated",
  );
  console.log("CRITERION2_COOKIE_ONLY", JSON.stringify({ events: cookieOnly.events }));
  cookieOnly.provider.destroy();

  const sentinel = makeProvider("phase0-auth-sentinel", {
    query: "?uid=phase0-cookie-user",
    token: "sentinel",
  });
  await waitFor(
    () => sentinel.events.some((e) => e.startsWith("authenticated")),
    "sentinel authenticated",
  );
  console.log("CRITERION2_SENTINEL", JSON.stringify({ events: sentinel.events }));
  sentinel.provider.destroy();

  const ok = makeProvider("phase0-auth-ok", { query: "?uid=phase0-cookie-user" });
  const denied = makeProvider("phase0-denied", { query: "?uid=phase0-cookie-user" });
  await waitFor(() => ok.events.includes("synced"), "allowed doc synced despite denied doc");
  await waitFor(
    () => denied.events.some((e) => e.startsWith("authenticationFailed")),
    "denied doc auth failed",
  );
  console.log(
    "CRITERION2_DOC_DENIAL",
    JSON.stringify({ okEvents: ok.events, deniedEvents: denied.events }),
  );
  ok.provider.destroy();
  denied.provider.destroy();

  const closeOnly = makeProvider("phase0-close", { query: "?mode=close4401", maxAttempts: 3 });
  await sleep(1200);
  console.log("CRITERION2_4401", JSON.stringify({ events: closeOnly.events, uncaught }));
  closeOnly.provider.destroy();

  const protocolClose = makeProvider("phase0-close-protocol", {
    query: "?mode=protocolClose&doc=phase0-close-protocol",
    maxAttempts: 3,
  });
  await sleep(1200);
  console.log(
    "CRITERION2_PROTOCOL_CLOSE",
    JSON.stringify({ events: protocolClose.events, uncaught }),
  );
  protocolClose.provider.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  await roundTrip();
  await auth();
}
