export * from "./agent-packages";
export * from "./agent-threads";
export { authSchema, authUsers } from "./auth";
export * from "./billing";
export * from "./content";
export * from "./provenance";
export * from "./results";
export * from "./user";
export * from "./waitlist";
export * from "./yjs";

import * as agentPackages from "./agent-packages";
import * as agentThreads from "./agent-threads";
import { authUsers } from "./auth";
import * as billing from "./billing";
import * as content from "./content";
import * as provenance from "./provenance";
import * as results from "./results";
import * as user from "./user";
import * as waitlist from "./waitlist";
import * as yjs from "./yjs";

/** Runtime Drizzle client schema (includes auth.users for FK-aware queries). */
export const schema = {
  authUsers,
  ...billing,
  ...content,
  ...agentThreads,
  ...agentPackages,
  ...provenance,
  ...results,
  ...user,
  ...waitlist,
  ...yjs,
};
