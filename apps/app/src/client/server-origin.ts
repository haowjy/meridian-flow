export function serverOrigin(): string {
  const configured = import.meta.env.VITE_SERVER_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");

  const url = new URL(window.location.origin);
  if (url.hostname === "app.meridian.localhost") {
    url.hostname = "server.meridian.localhost";
    return url.origin;
  }
  if (url.hostname.endsWith(".app.meridian.localhost")) {
    url.hostname = url.hostname.replace(".app.meridian.localhost", ".server.meridian.localhost");
    return url.origin;
  }
  return window.location.origin;
}

export function serverWebSocketUrl(path: string): string {
  const origin = new URL(serverOrigin());
  origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  origin.pathname = path;
  origin.search = "";
  origin.hash = "";
  return origin.toString();
}
