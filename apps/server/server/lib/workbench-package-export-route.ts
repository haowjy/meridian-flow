/**
 * Workbench package export route core: owner-gated zip download of the
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
import { requireWorkbenchOwner, type WorkbenchRepository } from "../domains/workbenches/index.js";

export interface WorkbenchPackageExportRouteDeps {
  workbenchRepo: WorkbenchRepository;
  packageRepository: PackageRepository;
}

export interface WorkbenchPackageExportRouteInput {
  workbenchId: string;
  userId: string;
  installId: string;
}

export interface WorkbenchPackageExportResult {
  filename: string;
  body: Buffer;
}

export async function handleExportPackageRequest(
  deps: WorkbenchPackageExportRouteDeps,
  input: WorkbenchPackageExportRouteInput,
): Promise<WorkbenchPackageExportResult> {
  await requireWorkbenchOwner({ workbenches: deps.workbenchRepo }, input.workbenchId, input.userId);
  const install = await findOwnedPackageInstall(
    deps.packageRepository,
    input.workbenchId,
    input.installId,
  );
  const exported = await exportMarsPackage({
    workbenchId: input.workbenchId,
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
