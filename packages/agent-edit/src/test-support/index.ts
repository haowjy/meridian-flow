// Test-support exports for shared agent-edit fakes.

export { harness as createWriteToolHarness } from "../tool/test-support/write-tool-harness.js";
export {
  InMemoryAgentEditJournal,
  type InMemoryAgentEditJournalOptions,
  type StoredAgentEditMutation,
} from "./in-memory-agent-edit.js";
