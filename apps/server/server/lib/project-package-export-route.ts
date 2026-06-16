/**
 * Project package export route core: owner-gated zip download of the
 * installed package's current definition content (as-edited, not pristine-only).
 *
 * TODO(git-sync): pull = fetch upstream commits via PackageInstallRecord.sourceCommitSha
 * into update reconciliation; push = export local definition revisions as commits on a branch.
 */
import { createError } from "nitro/h3";

import {
  buildMarsPackageZip,
  exportMarsPackage,
  findOwnedPackageInstall,
  type PackageRepository,
} from "../domains/packages/index.js";
import { type ProjectRepository, requireProjectOwner } from "../domains/projects/index.js";

export interface ProjectPackageExportRouteDeps {
  projectRepo: ProjectRepository;
  packageRepository: PackageRepository;
}

export interface ProjectPackageExportRouteInput {
  projectId: string;
  userId: string;
  installId: string;
}

export interface ProjectPackageExportResult {
  filename: string;
  body: Buffer;
}

export async function handleExportPackageRequest(
  deps: ProjectPackageExportRouteDeps,
  input: ProjectPackageExportRouteInput,
): Promise<ProjectPackageExportResult> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  const install = await findOwnedPackageInstall(
    deps.packageRepository,
    input.projectId,
    input.installId,
  );
  const exported = await exportMarsPackage({
    projectId: input.projectId,
    packageName: install.packageName,
    repository: deps.packageRepository,
  });
  if (!exported.files["mars.toml"]) {
    throw createError({ statusCode: 500, message: "Exported package is missing mars.toml" });
  }
  return {
    filename: `${install.packageName}.zip`,
    body: buildMarsPackageZip(exported),
  };
}
