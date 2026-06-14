import { defineEventHandler, getRequestHeader, sendNoContent, setHeader } from "nitro/h3";

export default defineEventHandler((event) => {
  const origin = getRequestHeader(event, "origin");
  if (origin && isAllowedAppOrigin(origin)) {
    setHeader(event, "Access-Control-Allow-Origin", origin);
    setHeader(event, "Access-Control-Allow-Credentials", "true");
    setHeader(event, "Access-Control-Allow-Headers", "Content-Type, Authorization");
    setHeader(event, "Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    setHeader(event, "Vary", "Origin");
  }

  if (event.req.method === "OPTIONS") {
    return sendNoContent(event, 204);
  }
});

function isAllowedAppOrigin(origin: string): boolean {
  const hostname = new URL(origin).hostname;
  return hostname === "app.meridian.localhost" || hostname.endsWith(".app.meridian.localhost");
}
