/** Durable vocabulary for the cache prediction recorded with a model response. */

export type PrefixCachePredictionState = "warm" | "cold";

export type PrefixCachePredictionReason =
  | "reusable_prefix"
  | "uncached"
  | "no_response"
  | "model_changed"
  | "prompt_epoch"
  | "image_eviction"
  | "compaction"
  | "ttl_unknown"
  | "summary_transcript"
  | "ttl_expired"
  | "fork_cutoff"
  | "fork_bake_changed"
  | "facts_unavailable";
