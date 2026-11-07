/**
 * Raises Node's 300 s `requestTimeout`, which cuts a request whose body takes longer to arrive:
 * a 200 MiB chat attach on a slow uplink needs more. Nitro doesn't expose the HTTP server, so
 * the first request reaches it through its socket.
 */
const REQUEST_TIMEOUT_MS = 60 * 60 * 1000;

type RequestLike = {
  runtime?: { node?: { req: { socket: { server?: { requestTimeout?: number } } } } };
};

export default function requestTimeoutPlugin(app: unknown) {
  let raised = false;
  (
    app as {
      hooks: { hook(name: "request", handler: (event: { req: RequestLike }) => void): void };
    }
  ).hooks.hook("request", (event) => {
    const server = event.req.runtime?.node?.req.socket.server;
    if (raised || !server) return;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    raised = true;
  });
}
