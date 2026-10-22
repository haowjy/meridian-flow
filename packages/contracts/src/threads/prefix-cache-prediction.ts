/** Durable vocabulary for the cache prediction recorded with a model response. */

import { z } from "zod";

export const prefixCachePredictionStateSchema = z.enum(["warm", "cold"]);
export type PrefixCachePredictionState = z.infer<typeof prefixCachePredictionStateSchema>;

export const prefixCachePredictionReasonSchema = z.enum([
  "reusable_prefix",
  "uncached",
  "no_response",
  "model_changed",
  "prompt_epoch",
  "image_eviction",
  "compaction",
  "ttl_unknown",
  "summary_transcript",
  "ttl_expired",
  "fork_cutoff",
  "fork_bake_changed",
  "facts_unavailable",
]);
export type PrefixCachePredictionReason = z.infer<typeof prefixCachePredictionReasonSchema>;
