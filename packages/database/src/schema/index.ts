export * from "./agent-definition-revisions";
export * from "./agent-threads";
export * from "./billing";
export * from "./collab";
export * from "./content";
export * from "./drafts";
export * from "./imports";
export * from "./loro";
export * from "./mcp";
export * from "./model-evidence";
export * from "./recent-documents";
export * from "./results";
export * from "./thread-asks";
export * from "./tree-nodes";
export * from "./user";
export * from "./users";
export * from "./waitlist";

import * as agentDefinitionRevisions from "./agent-definition-revisions";
import * as agentThreads from "./agent-threads";
import * as billing from "./billing";
import * as collab from "./collab";
import * as content from "./content";
import * as documentEdits from "./document-edits";
import * as drafts from "./drafts";
import * as imports from "./imports";
import * as loro from "./loro";
import * as mcp from "./mcp";
import * as modelEvidence from "./model-evidence";
import * as recentDocuments from "./recent-documents";
import * as results from "./results";
import * as threadAsks from "./thread-asks";
import * as treeNodes from "./tree-nodes";
import * as user from "./user";
import { users } from "./users";
import * as waitlist from "./waitlist";

export const schema = {
  users,
  ...billing,
  ...content,
  ...imports,
  ...mcp,
  ...drafts,
  ...agentThreads,
  ...threadAsks,
  ...treeNodes,
  ...agentDefinitionRevisions,
  ...recentDocuments,
  ...results,
  ...user,
  ...waitlist,
  ...collab,
  ...loro,
  ...documentEdits,
  ...modelEvidence,
};

export * from "./document-edits";
