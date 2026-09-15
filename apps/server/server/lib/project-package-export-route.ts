/**
 * Project package export route core: owner-gated zip download of the
 * installed package's current definition content (as-edited, not pristine-only).
 *
 */

import {
  type AgentRevisionStore,
  buildMarsPackageZip,
  exportMarsPackage,
  findOwnedPackageInstall,
} from "../domains/packages/index.js";
import { type ProjectRepository, requireProjectOwner } from "../domains/projects/index.js";

export interface ProjectPackageExportRouteDeps {
  projectRepo: ProjectRepository;
  agentRevisions: AgentRevisionStore;
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
  const install = await findOwnedPackageInstall(deps.agentRevisions, input.userId, input.installId);
  const exported = await exportMarsPackage({
    userId: input.userId,
    installId: install.id,
    store: deps.agentRevisions,
  });
  return {
    filename: `${install.coordinate.replace(/[^a-zA-Z0-9_-]/g, "-")}.zip`,
    body: buildMarsPackageZip(exported),
  };
}
