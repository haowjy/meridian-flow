/**
 * One writer-chosen context end as a route resolves it: the address a move or a copy
 * names, and the container its files live in. Each route parses its own locators and words
 * its own refusals; these are the meanings they share, so a move and a copy cannot disagree
 * about who owns an address or which URI spells it.
 */
import type { ProjectId, WorkId } from "@meridian/contracts/runtime";
import type { ResolvedWorkAuthority } from "@meridian/contracts/works";
import { projectBrowseContextUri } from "../domains/context/browse-layer-scheme.js";
import type {
  ProjectContextFsScheme,
  WorkScopedContextFsScheme,
} from "../domains/context/index.js";
import type { FileTarget } from "../domains/file-policy/index.js";

export type ProjectLocator = {
  scope: "project";
  scheme: ProjectContextFsScheme;
  path: string;
};

export type WorkLocator = {
  scope: "work";
  scheme: WorkScopedContextFsScheme;
  workId: string;
  path: string;
};

export type NoWorkLocator = {
  scope: "none";
  scheme: WorkScopedContextFsScheme;
  path: string;
};

export type LineageLocator = {
  scope: "lineage";
  scheme: "scratch";
  rootThreadId: string;
  path: string;
};

export type ContextLocator = ProjectLocator | NoWorkLocator | WorkLocator | LineageLocator;

export type ResolvedWorkLocator = Omit<WorkLocator, "workId"> & {
  authority: ResolvedWorkAuthority;
};
export type ResolvedLineageLocator = LineageLocator & {
  authority: { kind: "lineage"; rootThreadRef: string };
};
export type ResolvedContextLocator = ProjectLocator | ResolvedWorkLocator | ResolvedLineageLocator;

/** The URI that spells a locator's address. */
export function locatorUri(locator: ResolvedContextLocator, path = locator.path): string {
  return locator.scope !== "project"
    ? projectBrowseContextUri(locator.scheme, path, locator.authority)
    : projectBrowseContextUri(locator.scheme, path);
}

/** The container a locator's files live in: the file-policy target an edit is granted on. */
export function containerOf(locator: ResolvedContextLocator, projectId: string): FileTarget {
  return locator.scope === "project"
    ? {
        kind: "container",
        scheme: locator.scheme,
        owner: { scope: "project", projectId: projectId as ProjectId },
      }
    : locator.scope === "lineage"
      ? {
          kind: "container",
          scheme: "scratch",
          owner: {
            scope: "lineage",
            projectId,
            rootThreadId: locator.rootThreadId,
          },
        }
      : {
          kind: "container",
          scheme: locator.scheme,
          owner: { scope: "work", workId: locator.authority.workId as WorkId },
        };
}
