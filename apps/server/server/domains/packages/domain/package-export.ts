// @ts-nocheck
/**
 * Mars package export: reads an installed package's records from the repository
 * and renders them back into an in-memory Mars directory (mars.toml + definition
 * files). Inverse of package-sync's import; owns the records->directory mapping.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { stringify as stringifyToml } from "smol-toml";
import type { PackageRepository } from "../ports/package-store.js";
import { serializeMarkdownDefinition } from "./mars-source.js";
import { writeSkillFileToDisk } from "./skill-files.js";
import type { ExportedMarsDirectory } from "./types.js";

// TODO(git-sync): pull = fetch upstream commits via PackageInstallRecord.sourceCommitSha
// into update reconciliation; push = export local definition revisions as commits on a branch.

export async function exportMarsPackage(input: {
  workbenchId: string;
  packageName: string;
  repository: PackageRepository;
}): Promise<ExportedMarsDirectory> {
  return input.repository.transaction(async (tx) => {
    const packageInstall = await tx.findPackageInstall(input.workbenchId, input.packageName);
    if (!packageInstall) {
      throw new Error(`Package is not installed: ${input.packageName}`);
    }

    const agents = await tx.listPackageAgents(packageInstall.id);
    const skills = await tx.listPackageSkills(packageInstall.id);
    const files: ExportedMarsDirectory["files"] = {
      "mars.toml": stringifyToml({
        package: {
          name: packageInstall.packageName,
          ...(packageInstall.version ? { version: packageInstall.version } : {}),
          ...(packageInstall.description ? { description: packageInstall.description } : {}),
          ...(packageInstall.visibility !== "private"
            ? { visibility: packageInstall.visibility }
            : {}),
        },
        agents: Object.fromEntries(agents.map((agent) => [agent.slug, agent.config])),
      }),
    };

    for (const agent of agents) {
      files[`agents/${agent.slug}.md`] = serializeMarkdownDefinition(agent.meta, agent.body);
    }
    for (const skill of skills) {
      files[`skills/${skill.slug}/SKILL.md`] = serializeMarkdownDefinition(skill.meta, skill.body);
      for (const [relativePath, entry] of Object.entries(skill.files)) {
        files[`skills/${skill.slug}/${relativePath}`] = entry;
      }
    }

    return { files };
  });
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
