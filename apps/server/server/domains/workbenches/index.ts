// @ts-nocheck
/**
 * Barrel: re-exports the workbenches domain's public surface — workbench, user, and
 * work repository factories (drizzle + in-memory) plus their port types.
 */
export type { WorkbenchId } from "@meridian/contracts/runtime";
// ── User provisioning ───────────────────────────────────────────────────────
export { createDrizzleUserRepository } from "./adapters/user-repository/drizzle.js";
export { createInMemoryUserRepository } from "./adapters/user-repository/in-memory.js";
// ── Work CRUD ───────────────────────────────────────────────────────────────
export { createDrizzleWorkRepository } from "./adapters/work-repository/drizzle.js";
export { createInMemoryWorkRepository } from "./adapters/work-repository/in-memory.js";
// ── Workbench CRUD ────────────────────────────────────────────────────────────
export { createDrizzleWorkbenchRepository } from "./adapters/workbench-repository/drizzle.js";
export { createInMemoryWorkbenchRepository } from "./adapters/workbench-repository/in-memory.js";
export type { EnsureUserInput, UserRepository } from "./ports/user-repository.js";
export type {
  CreateWorkInput,
  ListWorksOptions,
  WorkRepository,
} from "./ports/work-repository.js";
export type {
  CreateWorkbenchInput,
  ListWorkbenchesOptions,
  UpdateWorkbenchInput,
  WorkbenchRepository,
} from "./ports/workbench-repository.js";
export { type RequireWorkbenchOwnerOptions, requireWorkbenchOwner } from "./workbench-access.js";
