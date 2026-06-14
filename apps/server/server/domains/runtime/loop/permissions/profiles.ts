import type { PermissionProfile } from "./types.js";

export const DEFAULT_PROFILE: PermissionProfile = { tools: { allow: ["*"] } };

export function resolveProfile(_name = "default"): PermissionProfile {
  return DEFAULT_PROFILE;
}
