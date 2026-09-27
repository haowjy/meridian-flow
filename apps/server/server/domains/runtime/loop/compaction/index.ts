/** Public surface of the pure compaction policy modules. */

export {
  CJK_CODE_POINT_TOKEN_MULTIPLIER,
  estimateRequestTokens,
  FILE_PART_TOKEN_ESTIMATE,
  IMAGE_PART_TOKEN_ESTIMATE,
} from "./estimate.js";
export type {
  CompactedThrough,
  CompactionPlan,
  PlanCompactionInput,
  RetainedTurnSlice,
} from "./plan.js";
export { DEFAULT_COMPACTION_TAIL_FRACTION, planCompaction } from "./plan.js";
export type {
  CompactionBlockContent,
  CompactionProps,
  ProjectedActiveHistory,
} from "./project.js";
export {
  CompactionBlockContentCodec,
  CompactionPropsCodec,
  projectActiveHistory,
} from "./project.js";
export type {
  CompactionTrigger,
  CompactionTriggerSource,
  ResolveCompactionTriggerInput,
} from "./trigger.js";
export { FLOW_ABSOLUTE_CEILING, resolveCompactionTrigger } from "./trigger.js";
