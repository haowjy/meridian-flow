import type { AccountSettings } from "@meridian/contracts/protocol";
import type { UserId } from "@meridian/contracts/runtime";
export interface AccountSettingsRepository {
  read(userId: UserId): Promise<AccountSettings>;
  update(userId: UserId, patch: Partial<AccountSettings>): Promise<AccountSettings>;
}
