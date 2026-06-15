/**
 * project-groups — groups projects into date buckets (today/yesterday/this
 * week/older) for the sidebar and recent lists. Thin wrapper over the shared
 * `groupByDate` helper specialized to `Project.updatedAt`.
 */
import type { Project } from "@meridian/contracts/projects";

import { type DateGroup, type GroupedByDate, groupByDate } from "./date-groups";

export type GroupedProjects = { group: DateGroup; projects: Project[] }[];

export function groupProjectsByDate(projects: Project[], now: number): GroupedProjects {
  return groupByDate(projects, (p) => p.updatedAt, now).map(
    ({ group, items }: GroupedByDate<Project>[number]) => ({ group, projects: items }),
  );
}
