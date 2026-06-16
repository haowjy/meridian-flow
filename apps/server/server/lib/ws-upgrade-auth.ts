import type { UserId } from "@meridian/contracts/runtime";
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

export function deferWsClose<TClose extends WsDeferredClose>(
  close: TClose,
): WsDeferredCloseUpgrade<TClose> {
  return { kind: "deferred-close", close };
}

export async function resolveWsUpgradeAuth(
  request: Request,
  options: { logPrefix?: string } = {},
): Promise<WsUpgradeAuthResult> {
  try {
    const auth = await resolveAppUserFromRequest(request);
    if (!auth) {
      return deferWsClose({ code: 4401, reason: "auth_failed" });
    }
    return { kind: "authenticated", app: auth.app, userId: auth.user.userId };
  } catch (error) {
    console.error(`${options.logPrefix ?? "ws-upgrade"}: auth error`, error);
    return deferWsClose({ code: 1011, reason: "auth_error" });
  }
}
