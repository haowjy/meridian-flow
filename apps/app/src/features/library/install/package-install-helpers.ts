// @ts-nocheck
/**
 * package-install-helpers — pure formatters for install preview and update reconciliation.
 *
 * Collision copy must match backend skip-and-keep semantics (preview truthfulness).
 */
import type {
  PackageInstallPreviewResponse,
  PackagePreviewCollision,
  PackageUpdateCheckResponse,
  PackageUpdateWillKeepItem,
  PackageUpdateWillUpdateItem,
} from "@meridian/contracts/agents";

export function githubSourceFromUrl(url: string): { kind: "github"; url: string } {
  const trimmed = url.trim();
  const normalized =
    trimmed.startsWith("http://") || trimmed.startsWith("https://")
      ? trimmed
      : `https://${trimmed}`;
  return { kind: "github", url: normalized };
}

export function catalogSourceFromId(catalogId: string): { kind: "catalog"; catalogId: string } {
  return { kind: "catalog", catalogId };
}

export function collisionLabel(collision: PackagePreviewCollision): string {
  const kindLabel = collision.kind === "agent" ? "agent" : "skill";
  return `${kindLabel} "${collision.slug}"`;
}

export function previewWillInstallAgents(preview: PackageInstallPreviewResponse): string[] {
  return preview.agents.map((agent) => agent.name);
}

export function previewWillInstallSkills(preview: PackageInstallPreviewResponse): string[] {
  return preview.skills.map((skill) => skill.name);
}

export function updateItemDisplayName(
  item: PackageUpdateWillUpdateItem | PackageUpdateWillKeepItem,
  nameBySlug: Map<string, string>,
): string {
  return nameBySlug.get(item.slug) ?? item.slug;
}

export function partitionUpdateCheck(check: PackageUpdateCheckResponse): {
  willUpdate: PackageUpdateWillUpdateItem[];
  willKeep: PackageUpdateWillKeepItem[];
} {
  return { willUpdate: check.willUpdate, willKeep: check.willKeep };
}
