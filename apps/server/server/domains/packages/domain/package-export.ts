/** Export exact retained package files; no reconstruction from mutable definition records. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRevisionStore } from "../ports/agent-revision-store.js";
import { findOwnedInstallation, requireSource } from "./package-management.js";
import { writeSkillFileToDisk } from "./skill-files.js";
import type { ExportedMarsDirectory } from "./types.js";
export async function exportMarsPackage(input: {
  userId: string;
  installId: string;
  store: AgentRevisionStore;
}): Promise<ExportedMarsDirectory> {
  const install = await findOwnedInstallation(input.store, input.userId, input.installId);
  const source = await requireSource(input.store, install.currentRevisionId);
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
