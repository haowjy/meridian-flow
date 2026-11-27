// Nitro dev's WS proxy crashes the dev server on a non-101 upgrade hook, so a rejection accepts the socket first and closes it from open()

import { WS_CLOSE } from "@meridian/contracts/protocol";
import type { UserId } from "@meridian/contracts/runtime";
import {
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../domains/observability/index.js";
import type { AppServices } from "./app.js";
import { resolveAppUserFromRequest } from "./auth-gate.js";

export type WsDeferredClose = typeof WS_CLOSE.AUTH_FAILED | typeof WS_CLOSE.AUTH_ERROR;

export type WsAuthenticatedUpgrade = Readonly<{
  kind: "authenticated";
  app: AppServices;
  userId: UserId;
  traceId: string;
}>;

export type WsDeferredCloseUpgrade<TClose extends WsDeferredClose = WsDeferredClose> = {
  kind: "deferred-close";
  close: TClose;
};

export type WsUpgradeAuthResult = WsAuthenticatedUpgrade | WsDeferredCloseUpgrade;

export function deferWsClose<TClose extends WsDeferredClose>(
  close: TClose,
): WsDeferredCloseUpgrade<TClose> {
  return { kind: "deferred-close", close };
}

export async function resolveWsUpgradeAuth(
  request: Request,
  options: { logPrefix: string; eventSink: EventSink; traceId?: string },
): Promise<WsUpgradeAuthResult> {
  const traceId = options.traceId ?? crypto.randomUUID();
  const { eventSink } = options;
  try {
    const auth = await resolveAppUserFromRequest(request);
    if (!auth) {
      return deferWsClose(WS_CLOSE.AUTH_FAILED);
    }
    return Object.freeze({
      kind: "authenticated",
      app: auth.app,
      userId: auth.user.userId,
      traceId,
    });
  } catch (error) {
    emitEvent(eventSink, {
      level: "error",
      source: "lib.ws-upgrade-auth",
      name: "upgrade_auth.failed",
      correlation: { traceId },
      payload: { logPrefix: options.logPrefix, ...unknownToEventPayload(error) },
    });
    return deferWsClose(WS_CLOSE.AUTH_ERROR);
  }
}
