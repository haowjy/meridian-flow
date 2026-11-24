// keep: Flow pins HTTP/1.1 until undici#6147 ships: aborting an HTTP/2 request before its headers throws UND_ERR_INFO as an uncaught exception later and the crash policy ends the process
import { Agent, type buildConnector, setGlobalDispatcher } from "undici";

export const OUTBOUND_CONNECT_OPTIONS = { allowH2: false } satisfies buildConnector.BuildOptions;

export function installOutboundHttp1(): void {
  setGlobalDispatcher(new Agent({ connect: OUTBOUND_CONNECT_OPTIONS }));
}
