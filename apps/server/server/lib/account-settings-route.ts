/** Account settings route core: validates partial absolute-set patches. */
import { ACCOUNT_LANGUAGES, ACCOUNT_THEMES } from "@meridian/contracts/preferences";
import type { AccountSettings } from "@meridian/contracts/protocol";
import type { UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import type { AccountSettingsRepository } from "../domains/preferences/index.js";
export function parseAccountSettingsPatch(raw: unknown): Partial<AccountSettings> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  const body = raw as Record<string, unknown>;
  const validators: Record<keyof AccountSettings, (value: unknown) => boolean> = {
    language: (v) => ACCOUNT_LANGUAGES.some((x) => x === v),
    theme: (v) => ACCOUNT_THEMES.some((x) => x === v),
    statsForNerds: (v) => typeof v === "boolean",
    workingSetSyncEnabled: (v) => typeof v === "boolean",
  };
  if (
    !Object.keys(body).length ||
    Object.entries(body).some(([key, value]) => !validators[key as keyof AccountSettings]?.(value))
  ) {
    throw createError({ statusCode: 400, message: "Invalid account preference" });
  }
  return body as Partial<AccountSettings>;
}
export function handleGetAccountSettings(
  settings: AccountSettingsRepository,
  userId: UserId,
): Promise<AccountSettings> {
  return settings.read(userId);
}
export function handlePatchAccountSettings(
  settings: AccountSettingsRepository,
  userId: UserId,
  patch: Partial<AccountSettings>,
): Promise<AccountSettings> {
  return settings.update(userId, patch);
}
