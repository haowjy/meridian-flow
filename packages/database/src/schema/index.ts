export * from "./auth";
export * from "./billing";
export * from "./content";
export * from "./conversations";
export * from "./package";
export * from "./provenance";
export * from "./user";
export * from "./yjs";

import * as auth from "./auth";
import * as billing from "./billing";
import * as content from "./content";
import * as conversations from "./conversations";
import * as packageSchema from "./package";
import * as provenance from "./provenance";
import * as user from "./user";
import * as yjs from "./yjs";

/** Runtime Drizzle client schema (includes auth.users for FK-aware queries). */
export const schema = {
  ...auth,
  ...billing,
  ...content,
  ...conversations,
  ...packageSchema,
  ...provenance,
  ...user,
  ...yjs,
};
