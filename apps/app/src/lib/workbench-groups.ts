// @ts-nocheck
/**
 * workbench-groups — groups workbenches into date buckets (today/yesterday/this
 * week/older) for the sidebar and recent lists. Thin wrapper over the shared
 * `groupByDate` helper specialized to `Workbench.updatedAt`.
 */
import type { Workbench } from "@meridian/contracts/workbenches";

import { type DateGroup, type GroupedByDate, groupByDate } from "./date-groups";

export type GroupedWorkbenches = { group: DateGroup; workbenches: Workbench[] }[];

export function groupWorkbenchesByDate(workbenches: Workbench[], now: number): GroupedWorkbenches {
  return groupByDate(workbenches, (p) => p.updatedAt, now).map(
    ({ group, items }: GroupedByDate<Workbench>[number]) => ({ group, workbenches: items }),
  );
}
