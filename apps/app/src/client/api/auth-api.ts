/** Typed client for the authenticated Meridian identity bootstrap. */
import { API_AUTH_ME_PATH, type AuthMeResponse } from "@meridian/contracts/protocol";
import { getJson } from "./http-client";

export type AuthMeRequestInit = {
  origin?: string;
  headers?: HeadersInit;
  signal?: AbortSignal;
};

export function getAuthMe(init?: AuthMeRequestInit): Promise<AuthMeResponse> {
  const url = init?.origin ? new URL(API_AUTH_ME_PATH, init.origin).toString() : API_AUTH_ME_PATH;
  return getJson<AuthMeResponse>(url, {
    headers: init?.headers,
    signal: init?.signal,
  });
}
