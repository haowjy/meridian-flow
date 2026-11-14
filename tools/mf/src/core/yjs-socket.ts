/** The Yjs socket as the session reaches it: its cookie, its CA and the collab schema subprotocol. */

import { yjsWsPath } from "@meridian/contracts/protocol";
import { COLLAB_SCHEMA_VERSION, formatCollabSchemaSubprotocol } from "@meridian/prosemirror-schema";
import WebSocket from "ws";
import type { Session } from "./session";

export function yjsSocketOptions(session: Session): { url: string; WebSocketPolyfill: unknown } {
  class SessionWebSocket extends WebSocket {
    constructor(url: string) {
      super(url, [formatCollabSchemaSubprotocol(COLLAB_SCHEMA_VERSION)], {
        ...(session.cookie ? { headers: { Cookie: session.cookie } } : {}),
        ...(session.ca ? { ca: session.ca } : {}),
      });
      // A close before the open is a state the provider reports; ws also raises it as an error.
      this.on("error", () => {});
    }
  }
  return {
    url: `${session.serverUrl.replace(/^http/, "ws")}${yjsWsPath()}`,
    WebSocketPolyfill: SessionWebSocket,
  };
}
