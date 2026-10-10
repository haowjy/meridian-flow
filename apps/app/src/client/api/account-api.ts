/** Typed client for authenticated account-level settings. */
import { type AccountSettings, API_ACCOUNT_SETTINGS_PATH } from "@meridian/contracts/protocol";
import { getJson, patchJson } from "./http-client";

let generation = 0;
/** Order browser reads against command settlements; SSR seeds start a new lifetime. */
export function nextAccountSettingsGeneration(): number {
  return typeof window === "undefined" ? 0 : ++generation;
}

export type AccountSettingsRequestInit = {
  origin?: string;
  headers?: HeadersInit;
  signal?: AbortSignal;
};

export function getAccountSettings(init?: AccountSettingsRequestInit): Promise<AccountSettings> {
  const url = init?.origin
    ? new URL(API_ACCOUNT_SETTINGS_PATH, init.origin).toString()
    : API_ACCOUNT_SETTINGS_PATH;
  return getJson<AccountSettings>(url, { headers: init?.headers, signal: init?.signal });
}

export function updateAccountSettings(
  settings: Partial<AccountSettings>,
  init?: AccountSettingsRequestInit,
): Promise<AccountSettings> {
  const url = init?.origin
    ? new URL(API_ACCOUNT_SETTINGS_PATH, init.origin).toString()
    : API_ACCOUNT_SETTINGS_PATH;
  return patchJson<AccountSettings>(url, settings, {
    headers: init?.headers,
    signal: init?.signal,
  });
}
