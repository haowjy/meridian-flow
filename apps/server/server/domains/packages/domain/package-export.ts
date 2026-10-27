/** Export exact retained package files; no reconstruction from mutable definition records. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentPackageInstallation,
  AgentRevisionStore,
} from "../ports/agent-revision-store.js";
import { writeSkillFileToDisk } from "./skill-files.js";
import type { ExportedMarsDirectory } from "./types.js";
export class PackageInstallationNotFoundError extends Error {}

export async function findOwnedInstallation(
  store: AgentRevisionStore,
  ownerUserId: string,
  id: string,
): Promise<AgentPackageInstallation> {
  const installation = (await store.listInstallations(ownerUserId)).find((item) => item.id === id);
  if (!installation) throw new PackageInstallationNotFoundError("Package install not found");
  return installation;
}

export async function exportMarsPackage(input: {
  userId: string;
  installId: string;
  store: AgentRevisionStore;
}): Promise<ExportedMarsDirectory> {
  const install = await findOwnedInstallation(input.store, input.userId, input.installId);
  const source = await input.store.readSource(install.currentRevisionId);
  if (!source) throw new Error("Installed package references missing retained source");
  return { files: source.files };
}

export async function writeExportedMarsDirectory(
  exported: ExportedMarsDirectory,
  outputDir: string,
): Promise<void> {
  for (const [relativePath, entry] of Object.entries(exported.files)) {
    const filePath = path.join(outputDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    if (typeof entry === "string") {
      await writeFile(filePath, entry, "utf8");
    } else {
      await writeSkillFileToDisk(filePath, entry);
    }
  }
}
