/**
 * Shared WebSocket upgrade auth and deferred-close result types.
 *
 * Nitro dev's WS proxy crashes the whole dev server when an upgrade hook returns
 * a non-101 response. Upgrade-time rejections must therefore accept the socket
 * first, then close it from open() with the deferred-close context.
 */

import type { UserId } from "@meridian/contracts/runtime";
import {
  createNoopEventSink,
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../domains/observability/index.js";
import type { AppServices } from "./app.js";
import { resolveAppUserFromRequest } from "./auth-gate.js";

export type WsDeferredClose = {
  code: number;
  reason: string;
};

export type WsAuthenticatedUpgrade = {
  kind: "authenticated";
  app: AppServices;
  userId: UserId;
};

export type WsDeferredCloseUpgrade<TClose extends WsDeferredClose = WsDeferredClose> = {
  kind: "deferred-close";
  close: TClose;
};

export type WsUpgradeAuthResult = WsAuthenticatedUpgrade | WsDeferredCloseUpgrade;

const defaultEventSink = createNoopEventSink();

export function deferWsClose<TClose extends WsDeferredClose>(
  close: TClose,
): WsDeferredCloseUpgrade<TClose> {
  return { kind: "deferred-close", close };
}

export async function resolveWsUpgradeAuth(
  request: Request,
  options: { logPrefix: string; eventSink?: EventSink },
): Promise<WsUpgradeAuthResult> {
  const eventSink = options.eventSink ?? defaultEventSink;
  try {
    const auth = await resolveAppUserFromRequest(request);
    if (!auth) {
      return deferWsClose({ code: 4401, reason: "auth_failed" });
    }
    return { kind: "authenticated", app: auth.app, userId: auth.user.userId };
  } catch (error) {
    emitEvent(eventSink, {
      level: "error",
      source: "lib.ws-upgrade-auth",
      name: "upgrade_auth.failed",
      payload: { logPrefix: options.logPrefix, ...unknownToEventPayload(error) },
    });
    return deferWsClose({ code: 1011, reason: "auth_error" });
  }
}
