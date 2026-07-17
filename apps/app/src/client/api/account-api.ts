/** Typed client for authenticated account-level settings. */
import { type AccountSettings, API_ACCOUNT_SETTINGS_PATH } from "@meridian/contracts/protocol";
import { getJson } from "./http-client";

type RequestInitOptions = { origin?: string; headers?: HeadersInit };

export function getAccountSettings(init?: RequestInitOptions): Promise<AccountSettings> {
  const url = init?.origin
    ? new URL(API_ACCOUNT_SETTINGS_PATH, init.origin).toString()
    : API_ACCOUNT_SETTINGS_PATH;
  return getJson<AccountSettings>(url, { headers: init?.headers });
}
