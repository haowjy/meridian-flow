// CRDT-lineage classification for destructive content removed at the atomic live cut.

import type { ContentLineage } from "../ports/model.js";
import type { BlockSnapshot } from "./echo.js";
import { lineageCovered } from "./echo.js";

export interface DestructiveClassificationInput {
  before: readonly BlockSnapshot[];
  after: readonly BlockSnapshot[];
  protectedLineage: readonly ContentLineage[];
  lineageOrigins: readonly (ContentLineage & { origin: "human" | "agent" })[];
}

/**
 * Return blocks containing late human-visible prose that the mutation removed.
 *
 * Baseline prose is part of the mutation the agent intentionally authored.
 * Journal-attributed agent prose is not writer content. Every other late
 * lineage is human or unknown; unknown lineages fail toward reporting because
 * an unjournaled live edit may have landed after the journal-origin recheck.
 */
export function classifyDestructiveBlocks(input: DestructiveClassificationInput): BlockSnapshot[] {
  const retained = input.after.flatMap((block) => block.lineage ?? []);
  return input.before.filter((block) =>
    (block.lineage ?? []).some(
      (lineage) =>
        !lineageCovered(lineage, retained) &&
        !lineageCovered(lineage, input.protectedLineage) &&
        !input.lineageOrigins.some(
          (candidate) => candidate.origin === "agent" && lineageCovered(lineage, [candidate]),
        ),
    ),
  );
}
