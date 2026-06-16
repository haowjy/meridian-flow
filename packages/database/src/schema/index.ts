export * from "./agent-packages";
export * from "./agent-threads";
export * from "./billing";
export * from "./content";
export * from "./preferences";
export * from "./provenance";
export * from "./results";
export * from "./user";
export * from "./users";
export * from "./waitlist";
export * from "./yjs";

import * as agentPackages from "./agent-packages";
import * as agentThreads from "./agent-threads";
import * as billing from "./billing";
import * as content from "./content";
import * as preferences from "./preferences";
import * as provenance from "./provenance";
import * as results from "./results";
import * as user from "./user";
import { users } from "./users";
import * as waitlist from "./waitlist";
import * as yjs from "./yjs";

/** Runtime Drizzle client schema (public tables + views). */
export const schema = {
  users,
  ...billing,
  ...content,
  ...agentThreads,
  ...agentPackages,
  ...provenance,
  ...preferences,
  ...results,
  ...user,
  ...waitlist,
  ...yjs,
};
