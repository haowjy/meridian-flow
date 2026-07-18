/** Typed client for authenticated account-level settings. */
import { type AccountSettings, API_ACCOUNT_SETTINGS_PATH } from "@meridian/contracts/protocol";
import { getJson, patchJson } from "./http-client";

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

export function updateAccountSettings(settings: AccountSettings): Promise<AccountSettings> {
  return patchJson<AccountSettings>(API_ACCOUNT_SETTINGS_PATH, settings);
}
