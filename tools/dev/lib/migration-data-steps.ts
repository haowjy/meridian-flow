/**
 * Registry of versioned data steps the migration runner executes inside its advisory-locked run.
 *
 * A step is code that must run between two SQL migrations (here: before the destructive drop of
 * `live_cut`) and cannot be SQL. Its identity is the marker `-- data-step: <id>@<version>` in the SQL of
 * the migration it must precede, the anchor. The marker is the only link: the registry is keyed by
 * `id@version`, so a renumbered migration needs no registry edit, and the SQL hash recorded in
 * `drizzle.__drizzle_migrations` already covers the marker. Changing conversion semantics means a new
 * version, a new marker and a new migration entry.
 *
 * Strict both ways, before any work: a pending migration whose marker names an unregistered
 * `id@version` (no step, or another version of one) refuses the run, and so does a registered step
 * marked by more than one migration. A registered step with no marker in the given history has nothing
 * pending; the repository's own history keeps every registered step anchored (a durable test).
 */
import {
  convertReviewBases,
  type DataStepContext,
  preflightReviewBaseConversion,
  REVIEW_BASE_CONVERSION_STEP_ID,
} from "@meridian/database/migration-steps";
import type postgres from "postgres";
import type { MigrationIdentity } from "./migration-history";

export interface MigrationDataStep {
  id: string;
  /** Bump when the step's conversion semantics change; the anchor migration's marker must follow. */
  version: number;
  /** Read-only. Runs before the first pending migration of the run; throwing refuses the whole run. */
  preflight(session: postgres.Sql, context: DataStepContext): Promise<void>;
  /** Runs immediately before the anchor migration, in the same run and under the same lock. */
  run(session: postgres.Sql, context: DataStepContext): Promise<unknown>;
}

export const MIGRATION_DATA_STEPS: readonly MigrationDataStep[] = [
  {
    id: REVIEW_BASE_CONVERSION_STEP_ID,
    version: 1,
    preflight: preflightReviewBaseConversion,
    run: convertReviewBases,
  },
];

const MARKER = /^--[ \t]*data-step:[ \t]*([\w-]+)@(\d+)[ \t]*$/gm;

export function stepKey(step: { id: string; version: number }): string {
  return `${step.id}@${step.version}`;
}

function markersOf(entry: MigrationIdentity): string[] {
  return [...entry.sql.toString("utf8").matchAll(MARKER)].map((match) => `${match[1]}@${match[2]}`);
}

export interface DataStepPlan {
  issues: string[];
  /** Steps whose anchor is pending, with the anchor's tag, in anchor order. */
  due: { step: MigrationDataStep; anchorTag: string }[];
}

export function planDataSteps(
  steps: readonly MigrationDataStep[],
  entries: readonly MigrationIdentity[],
  pendingTags: ReadonlySet<string>,
): DataStepPlan {
  const issues: string[] = [];
  const registered = new Map(steps.map((step) => [stepKey(step), step]));
  const anchors = new Map<string, string[]>();
  for (const entry of entries) {
    for (const key of markersOf(entry)) {
      anchors.set(key, [...(anchors.get(key) ?? []), entry.tag]);
      if (pendingTags.has(entry.tag) && !registered.has(key)) {
        const registeredVersion = steps.find((step) => key.startsWith(`${step.id}@`));
        issues.push(
          registeredVersion
            ? `${entry.tag} is marked ${key} but the registered step is ${stepKey(registeredVersion)}`
            : `${entry.tag} is marked ${key} but no data step is registered for it`,
        );
      }
    }
  }
  const due: DataStepPlan["due"] = [];
  for (const step of steps) {
    const tags = anchors.get(stepKey(step)) ?? [];
    if (tags.length > 1) {
      issues.push(
        `data step ${stepKey(step)} is marked by ${tags.length} migrations (${tags.join(", ")})`,
      );
    } else if (tags[0] && pendingTags.has(tags[0])) due.push({ step, anchorTag: tags[0] });
  }
  return { issues, due };
}
