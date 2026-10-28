/** Export exact retained package files; no reconstruction from mutable definition records. */
import type { AgentRevisionStore } from "../ports/agent-revision-store.js";
import type { ExportedMarsDirectory } from "./types.js";

export class PackageInstallationNotFoundError extends Error {}

export async function exportMarsPackage(input: {
  userId: string;
  installId: string;
  store: AgentRevisionStore;
}): Promise<{ coordinate: string; exported: ExportedMarsDirectory }> {
  const install = (await input.store.listInstallations(input.userId)).find(
    (item) => item.id === input.installId,
  );
  if (!install) throw new PackageInstallationNotFoundError("Package install not found");
  const source = await input.store.readSource(install.currentRevisionId);
  if (!source) throw new Error("Installed package references missing retained source");
  return { coordinate: install.coordinate, exported: { files: source.files } };
}
