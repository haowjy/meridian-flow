/** Project-owned readable handle allocation shared by persistence adapters. */
import type { ProjectId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { contextSources } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../../shared/drizzle-transaction.js";

const MAX_SLUG_BASE_LENGTH = 80;

export const DEFAULT_PROJECT_TITLE = "Untitled Project";

/** Ensures the project-scoped source that anchors its manifest/catalog identity. */
export async function ensureProjectManifestSource(
  db: Database,
  projectId: ProjectId,
): Promise<string> {
  const tx = currentDrizzleDb(db);
  const [existing] = await tx
    .select({ id: contextSources.id })
    .from(contextSources)
    .where(
      and(
        eq(contextSources.projectId, projectId),
        eq(contextSources.slug, "manuscript"),
        isNull(contextSources.deletedAt),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [source] = await tx
    .insert(contextSources)
    .values({
      projectId,
      name: "Manuscript",
      slug: "manuscript",
      scope: "project",
      adapterType: "local",
      isPrimary: true,
    })
    .returning({ id: contextSources.id });
  if (!source)
    throw new Error(`Failed to create manuscript context source for project ${projectId}`);
  return source.id;
}

export function nextProjectSlug(title: string, existingSlugs: Iterable<string>): string {
  const base =
    title
      .normalize("NFKD")
      .replace(/\p{Mark}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SLUG_BASE_LENGTH)
      .replace(/-+$/g, "") || "project";
  const taken = new Set(existingSlugs);
  if (!taken.has(base)) return base;
  // With N reserved values, one of the first N + 1 candidates is free.
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
