/** Account settings route core: strictly parses and reads or updates authenticated user settings. */
import type { UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import type { UserRepository } from "../domains/projects/index.js";

export type AccountSettings = { workingSetSyncEnabled: boolean };

export function parseAccountSettingsPatch(raw: unknown): AccountSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  }
  const enabled = (raw as Record<string, unknown>).workingSetSyncEnabled;
  if (typeof enabled !== "boolean") {
    throw createError({ statusCode: 400, message: "`workingSetSyncEnabled` must be a boolean" });
  }
  return { workingSetSyncEnabled: enabled };
}

export async function handleGetAccountSettings(
  users: UserRepository,
  userId: UserId,
): Promise<AccountSettings> {
  return { workingSetSyncEnabled: await users.getWorkingSetSyncEnabled(userId) };
}

export async function handlePatchAccountSettings(
  users: UserRepository,
  userId: UserId,
  settings: AccountSettings,
): Promise<AccountSettings> {
  return {
    workingSetSyncEnabled: await users.updateWorkingSetSyncEnabled(
      userId,
      settings.workingSetSyncEnabled,
    ),
  };
}
