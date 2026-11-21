// Test-support exports for shared agent-edit fakes.

export {
  blockTexts,
  hashAt,
  humanDeleteBlock,
  humanText,
  outcomeText,
  renderedBlockBodies,
} from "../tool/test-support/assertions.js";
export { harness as createWriteToolHarness } from "../tool/test-support/write-tool-harness.js";
export { InMemoryAgentEditJournal } from "./in-memory-agent-edit.js";
export { suggestRewrite } from "./suggested-rewrite.js";
export { applyTextEdit } from "./text-edit.js";
