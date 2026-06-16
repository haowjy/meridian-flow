/**
 * Package install/update contract — preview-before-commit and reconciliation shapes.
 *
 * Preview responses must mirror what apply actually does: slug collisions against
 * the project inventory surface as `keep_existing` (skip-and-keep), matching
 * `package-sync` import semantics — never promise "will install" for a slug that
 * apply would skip.
 *
 * Key decisions:
 * - JSON-natural per the contracts package rule.
 * - Install source is a tagged union: GitHub URL or first-party catalog id.
 * - Update check separates pristine (will update) from edited (will keep).
 */

/** How the client specifies a package source for preview or install. */
export type PackageInstallSource =
  | { kind: "github"; url: string; ref?: string }
  | { kind: "catalog"; catalogId: string };

/** Request body for `POST /api/projects/:wb/packages/preview`. */
export interface PackageInstallPreviewRequest {
  source: PackageInstallSource;
}

/** One agent the package would contribute (or skip on collision). */
export interface PackagePreviewAgent {
  slug: string;
  name: string;
  description: string;
}

/** One skill the package would contribute (or skip on collision). */
export interface PackagePreviewSkill {
  slug: string;
  name: string;
  description: string;
}

/** Slug already owned by the project — apply keeps the existing definition. */
export interface PackagePreviewCollision {
  slug: string;
  kind: "agent" | "skill";
  /** Always `keep_existing` today — preview truthfulness guard for install UX. */
  action: "keep_existing";
}

/** Response for install preview (dry-run, no writes). */
export interface PackageInstallPreviewResponse {
  packageName: string;
  version: string | null;
  description: string | null;
  agents: PackagePreviewAgent[];
  skills: PackagePreviewSkill[];
  collisions: PackagePreviewCollision[];
  /** True when the source tree contains `BOOTSTRAP.md` at the package root. */
  includesSetupInstructions: boolean;
  /** Package names already installed in this project (dependency graph skips). */
  skippedPackages: string[];
}

/** Request body for `POST /api/projects/:wb/packages` (apply install). */
export interface PackageInstallApplyRequest {
  source: PackageInstallSource;
}

/** One installed package row after apply. */
export interface PackageInstallSummary {
  id: string;
  packageName: string;
  version: string | null;
}

/** Response after a successful install apply. */
export interface PackageInstallApplyResponse {
  installedPackages: PackageInstallSummary[];
  skippedPackages: string[];
  insertedAgents: string[];
  insertedSkills: string[];
  skippedAgents: string[];
  skippedSkills: string[];
}

/** One item that will receive upstream content on update apply. */
export interface PackageUpdateWillUpdateItem {
  slug: string;
  kind: "agent" | "skill";
}

/** One item kept because the user edited it locally. */
export interface PackageUpdateWillKeepItem {
  slug: string;
  kind: "agent" | "skill";
}

/** One item soft-retired because upstream removed it and history exists. */
export interface PackageUpdateWillRetireItem {
  slug: string;
  kind: "agent" | "skill";
}

/** Response for `GET .../packages/:installId/update` (update check). */
export interface PackageUpdateCheckResponse {
  installId: string;
  packageName: string;
  currentVersion: string | null;
  upstreamVersion: string | null;
  upstreamCommitSha: string | null;
  willUpdate: PackageUpdateWillUpdateItem[];
  willKeep: PackageUpdateWillKeepItem[];
  willRemove: PackageUpdateWillUpdateItem[];
  willRetire: PackageUpdateWillRetireItem[];
  /** True when upstream differs from the installed metadata or content plan. */
  updateAvailable: boolean;
}

/** Response for `POST .../packages/:installId/update` (apply update). */
export interface PackageUpdateApplyResponse {
  installId: string;
  packageName: string;
  version: string | null;
  updatedAgents: string[];
  updatedSkills: string[];
  keptAgents: string[];
  keptSkills: string[];
  removedAgents: string[];
  removedSkills: string[];
  retiredAgents: string[];
  retiredSkills: string[];
}

/** One entry in the promoted first-party catalog (`GET /api/packages/catalog`). */
export interface FirstPartyCatalogEntry {
  id: string;
  name: string;
  description: string;
  /** GitHub repo URL when installable; null while gallery-only (client disables Install). */
  sourceUrl: string | null;
}

/** Response for `GET /api/packages/catalog`. */
export interface FirstPartyCatalogResponse {
  packages: FirstPartyCatalogEntry[];
}
