/**
 * Flow speaks HTTP/1.1 on every outbound request until an undici release carries the fix for
 * nodejs/undici#6143.
 *
 * Node 26's `fetch` (undici 8.12.4) offers HTTP/2, and so do the providers and WorkOS. Aborting
 * a request before its response headers arrive can leave a stream Node tracks but undici does not;
 * when the server's reply lands after the abort, the idle-socket close about four seconds later
 * throws `UND_ERR_INFO` as an uncaught exception, and the crash policy ends the process. The fix
 * is nodejs/undici#6147, still open. The gateway aborts constantly (Stop, the stall timeout).
 *
 * `installOutboundHttp1` covers the global `fetch`. An undici `Agent` with its own `connect`
 * ignores the global dispatcher, so it builds its connector with `OUTBOUND_CONNECT_OPTIONS`.
 *
 * Installing this dispatcher replaces Node's env-proxy dispatcher (`NODE_USE_ENV_PROXY` /
 * `--use-env-proxy`). A future proxy setup has to wrap it, for example with `EnvHttpProxyAgent`
 * and the same connect options.
 *
 * Delete this module, its call in `plugins/startup.ts` and its use in
 * `public-address-dispatcher.ts` when a release with the fix ships and the `undici` pin moves to it.
 */
import { Agent, type buildConnector, setGlobalDispatcher } from "undici";

export const OUTBOUND_CONNECT_OPTIONS = { allowH2: false } satisfies buildConnector.BuildOptions;

export function installOutboundHttp1(): void {
  setGlobalDispatcher(new Agent({ connect: OUTBOUND_CONNECT_OPTIONS }));
}
