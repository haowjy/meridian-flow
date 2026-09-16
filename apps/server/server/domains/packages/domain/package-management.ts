/** Account-owned package import, update and export over the retained source publication boundary. */
import { isDeepStrictEqual } from "node:util";
import type {
  PackageInstallApplyResponse,
  PackageInstallPreviewResponse,
} from "@meridian/contracts/agents";
import type {
  AgentPackageInstallation,
  AgentRevisionStore,
} from "../ports/agent-revision-store.js";
import type { AgentSourceSnapshot } from "./agent-source-revision.js";
import { parseMarkdownDefinition, parseMarsToml } from "./mars-source.js";
import { reconcilePackageSource, sourceEntities } from "./package-reconciliation.js";
import type { PackageSourceNode } from "./package-source.js";
import { AgentPublicationConflictError, publishAgentSource } from "./source-publication.js";

export function packageMetadata(source: AgentSourceSnapshot) {
  const manifest = source.files["mars.toml"];
  return typeof manifest === "string"
    ? parseMarsToml(manifest, { packageNameFallback: source.coordinate }).package
    : { name: source.coordinate };
}
export async function findOwnedInstallation(
  store: AgentRevisionStore,
  ownerUserId: string,
  id: string,
): Promise<AgentPackageInstallation> {
  const installation = (await store.listInstallations(ownerUserId)).find((item) => item.id === id);
  if (!installation) throw new PackageInstallationNotFoundError("Package install not found");
  return installation;
}
export class PackageInstallationNotFoundError extends Error {}
export async function requireSource(
  store: AgentRevisionStore,
  id: string,
): Promise<AgentSourceSnapshot> {
  const source = await store.readSource(id);
  if (!source) throw new Error("Installed package references missing retained source");
  return source;
}
export async function previewPackageGraph(
  store: AgentRevisionStore,
  owner: string,
  graph: PackageSourceNode[],
): Promise<PackageInstallPreviewResponse> {
  const root = graph.at(-1);
  if (!root) throw new Error("Empty package graph");
  const manifest = packageMetadata(root.source);
  const existing = await store.listInstallations(owner);
  const occupied = new Map<string, string>();
  for (const installation of existing)
    for (const entity of sourceEntities(await requireSource(store, installation.currentRevisionId)))
      occupied.set(`${entity.kind}/${entity.slug}`, installation.coordinate);
  const result: PackageInstallPreviewResponse = {
    packageName: manifest.name,
    version: manifest.version ?? null,
    description: manifest.description ?? null,
    agents: [],
    skills: [],
    collisions: [],
    includesSetupInstructions: Object.hasOwn(root.source.files, "BOOTSTRAP.md"),
    skippedPackages: [],
  };
  for (const node of graph) {
    if (existing.some((item) => item.coordinate === node.source.coordinate)) {
      result.skippedPackages.push(node.source.coordinate);
      continue;
    }
    for (const entity of sourceEntities(node.source)) {
      const key = `${entity.kind}/${entity.slug}`;
      // Include catalog-only canonical standalone entries created before package management existed.
      const entry =
        entity.kind === "agent" ? await store.readCatalogEntry(owner, entity.slug) : undefined;
      const collision = occupied.get(key) ?? (entry ? "existing Agent catalog entry" : undefined);
      if (collision) {
        result.collisions.push({
          slug: entity.slug,
          kind: entity.kind,
          action: "rename_required",
          source: collision,
        });
        continue;
      }
      occupied.set(key, node.source.coordinate);
      const file =
        entity.files[
          entity.kind === "agent" ? `agents/${entity.slug}.md` : `skills/${entity.slug}/SKILL.md`
        ];
      if (typeof file !== "string") throw new Error("Definition must be UTF-8 text");
      const { meta } = parseMarkdownDefinition(file);
      const summary = {
        slug: entity.slug,
        name: typeof meta.name === "string" ? meta.name : entity.slug,
        description: typeof meta.description === "string" ? meta.description : "",
      };
      (entity.kind === "agent" ? result.agents : result.skills).push(summary);
    }
  }
  return result;
}
export async function importPackageGraph(
  store: AgentRevisionStore,
  owner: string,
  graph: PackageSourceNode[],
): Promise<PackageInstallApplyResponse> {
  return store.withCatalogTransaction(owner, async () => {
    const preview = await previewPackageGraph(store, owner, graph);
    if (preview.collisions.length)
      throw new AgentPublicationConflictError(
        preview.collisions
          .map(
            (item) =>
              `${item.kind} "${item.slug}" belongs to ${item.source}; rename before importing`,
          )
          .join(". "),
      );
    const result: PackageInstallApplyResponse = {
      installedPackages: [],
      skippedPackages: preview.skippedPackages,
      insertedAgents: [],
      insertedSkills: [],
      skippedAgents: [],
      skippedSkills: [],
    };
    const heads = new Map(
      (await store.listInstallations(owner)).map((item) => [
        item.coordinate,
        item.currentRevisionId,
      ]),
    );
    for (const node of graph) {
      if (heads.has(node.source.coordinate)) continue;
      const dependencies = Object.fromEntries(
        Object.entries(node.dependencies).map(([name, coordinate]) => {
          const id = heads.get(coordinate);
          if (!id) throw new Error(`Missing installed dependency ${coordinate}`);
          return [name, id];
        }),
      );
      const source = { ...node.source, dependencies };
      const published = await publishAgentSource({
        store,
        ownerUserId: owner,
        source,
        origin: node.origin,
      });
      heads.set(source.coordinate, published.packageRevisionId);
      const meta = packageMetadata(source);
      result.installedPackages.push({
        id: published.installation.id,
        packageName: meta.name,
        version: meta.version ?? null,
      });
      for (const entity of sourceEntities(source))
        (entity.kind === "agent" ? result.insertedAgents : result.insertedSkills).push(entity.slug);
    }
    return result;
  });
}

/** Fetching is outside the transaction; this read/merge/publish decision is serialized with edits. */
export async function updatePackageGraph(
  store: AgentRevisionStore,
  owner: string,
  installation: AgentPackageInstallation,
  graph: PackageSourceNode[],
  apply: boolean,
  forceReset = false,
) {
  return store.withCatalogTransaction(owner, async () => {
    const currentHead = await findOwnedInstallation(store, owner, installation.id);
    if (currentHead.currentRevisionId !== installation.currentRevisionId)
      throw new AgentPublicationConflictError("Package changed during update fetch; retry.");
    const root = graph.at(-1);
    if (!root || root.source.coordinate !== installation.coordinate)
      throw new AgentPublicationConflictError("Upstream package identity changed");
    const current = await requireSource(store, installation.currentRevisionId);
    const pristine = await requireSource(store, installation.upstreamRevisionId);
    if (apply && graph.length > 1) await importPackageGraph(store, owner, graph.slice(0, -1));
    const heads = new Map(
      (await store.listInstallations(owner)).map((item) => [
        item.coordinate,
        item.currentRevisionId,
      ]),
    );
    // Existing dependency heads are retained; newly declared dependencies join the same publication.
    const dependencies: Record<string, string> = {};
    for (const [name, coordinate] of Object.entries(root.dependencies)) {
      const id = heads.get(coordinate);
      if (id) dependencies[name] = id;
      else if (apply) throw new Error(`Dependency was not installed: ${coordinate}`);
    }
    const incoming = { ...root.source, dependencies };
    const plan = reconcilePackageSource(current, pristine, incoming, forceReset);
    const currentMeta = packageMetadata(current),
      upstreamMeta = packageMetadata(incoming);
    const preview = {
      installId: installation.id,
      packageName: installation.coordinate,
      currentVersion: currentMeta.version ?? null,
      upstreamVersion: upstreamMeta.version ?? null,
      upstreamCommitSha: root.origin?.commitSha ?? null,
      willKeep: plan.willKeep,
      willUpdate: plan.willUpdate,
      willRetire: plan.willRetire,
      willRemove: plan.willRemove,
      updateAvailable:
        !isDeepStrictEqual(current, plan.source) || !isDeepStrictEqual(pristine, incoming),
    };
    if (apply) {
      const upstream = await store.installSource(incoming);
      await publishAgentSource({
        store,
        ownerUserId: owner,
        source: plan.source,
        upstreamRevisionId: upstream.packageRevisionId,
        expectedRevisionId: installation.currentRevisionId,
        origin: root.origin,
      });
    }
    return preview;
  });
}
