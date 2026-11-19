/** `@meridian/agent-edit/content-merge`: the three-way merge of a draft's blocks with live's, and its rules. */

export { applyBase } from "./apply-base.js";
export { type ContentMergeResult, contentMerge } from "./merge.js";
export { addCounts, RULES, type RuleCounts, type RuleName, ruleCounter } from "./rules.js";
export {
  addsPendingChange,
  type ChangeMemo,
  type ChangeRead,
  type ChangeState,
  captureDelta,
  changeState,
  changeStateIn,
  type EditChange,
  type EditDelta,
  editChanges,
  type Reading,
  readChange,
  readChangeWhole,
  readDelta,
  readDraft,
  type StoredDelta,
  takeOut,
} from "./stands.js";
