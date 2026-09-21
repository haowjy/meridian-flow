export * from "./account-skill-installs";
export * from "./agent-definition-revisions";
export * from "./agent-threads";
export * from "./billing";
export * from "./content";
export * from "./context-catalog";
export * from "./context-operation-receipts";
export * from "./preferences";
export * from "./provenance";
export * from "./recent-documents";
export * from "./results";
export * from "./user";
export * from "./users";
export * from "./waitlist";
export * from "./working-sets";
export * from "./yjs";

import * as accountSkillInstalls from "./account-skill-installs";
import * as agentDefinitionRevisions from "./agent-definition-revisions";
import * as agentThreads from "./agent-threads";
import * as billing from "./billing";
import * as content from "./content";
import * as contextCatalog from "./context-catalog";
import * as contextOperations from "./context-operation-receipts";
import * as preferences from "./preferences";
import * as provenance from "./provenance";
import * as recentDocuments from "./recent-documents";
import * as results from "./results";
import * as user from "./user";
import { users } from "./users";
import * as waitlist from "./waitlist";
import * as workingSets from "./working-sets";
import * as yjs from "./yjs";

/** Runtime Drizzle client schema (public tables + views). */
export const schema = {
  users,
  ...accountSkillInstalls,
  ...billing,
  ...content,
  ...contextCatalog,
  ...contextOperations,
  ...agentThreads,
  ...agentDefinitionRevisions,
  ...provenance,
  ...recentDocuments,
  ...preferences,
  ...results,
  ...user,
  ...waitlist,
  ...workingSets,
  ...yjs,
};
