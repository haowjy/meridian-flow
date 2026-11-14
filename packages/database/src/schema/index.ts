export * from "./account-skill-installs";
export * from "./agent-definition-revisions";
export * from "./agent-threads";
export * from "./billing";
export * from "./branches";
export * from "./content";
export * from "./imports";
export * from "./recent-documents";
export * from "./results";
export * from "./thread-asks";
export * from "./tree-nodes";
export * from "./user";
export * from "./users";
export * from "./waitlist";
export * from "./working-sets";
export * from "./yjs";

import * as accountSkillInstalls from "./account-skill-installs";
import * as agentDefinitionRevisions from "./agent-definition-revisions";
import * as agentThreads from "./agent-threads";
import * as billing from "./billing";
import * as branches from "./branches";
import * as content from "./content";
import * as documentEdits from "./document-edits";
import * as imports from "./imports";
import * as recentDocuments from "./recent-documents";
import * as results from "./results";
import * as threadAsks from "./thread-asks";
import * as treeNodes from "./tree-nodes";
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
  ...imports,
  ...branches,
  ...agentThreads,
  ...threadAsks,
  ...treeNodes,
  ...agentDefinitionRevisions,
  ...recentDocuments,
  ...results,
  ...user,
  ...waitlist,
  ...workingSets,
  ...yjs,
  ...documentEdits,
};

export * from "./document-edits";
