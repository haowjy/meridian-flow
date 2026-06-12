// @ts-nocheck
// Mars package sync: imports package-authored agents, skills, and ordered links into repositories.
//
// Overview:
// importLocalMarsPackage: resolves the dependency graph from a local mars.toml directory
//   (recursive, cycle-safe), then writes everything in one transaction.
// updateLocalMarsPackage: reconciles an already-installed package with upstream changes,
//   auto-updating pristine records, skipping locally edited ones, and preserving
//   subagent DAGs pruned upstream.

import { access } from "node:fs/promises";
import path from "node:path";

import type {
  PackagePreviewAgent,
  PackagePreviewCollision,
  PackagePreviewSkill,
  PackageUpdateWillKeepItem,
  PackageUpdateWillRetireItem,
  PackageUpdateWillUpdateItem,
} from "@meridian/contracts/agents";
import type { MarsPackageFetcher } from "../ports/mars-package-fetcher.js";
import type { PackageRepository, PackageWriteTransaction } from "../ports/package-store.js";
import { seedInitialAgentRevision, seedInitialSkillRevision } from "./definition-editing.js";
import { isNodeError, stringAt, stringsAt } from "./helpers.js";
import {
  agentDefinitionContentChecksum,
  definitionContentChecksum,
  parseMarsPackageSource,
} from "./mars-source.js";
import {
  isPackageImportError,
  packageDependencyUnresolved,
  packageImportError,
} from "./package-import-error.js";
import type {
  AgentDefinitionRecord,
  AgentSkillLinkRecord,
  MarsDependency,
  PackageImportResult,
  PackageInstallRecord,
  PackageUpdateResult,
  PackageVisibility,
  ParsedAgentDefinition,
  ParsedMarsPackageSource,
  ParsedSkillDefinition,
  SkillRecord,
} from "./types.js";

interface PackageGraphNode {
  source: ParsedMarsPackageSource;
  sourceCommitSha: string | null;
}

interface LinkLookup {
  agentsBySlug: Map<string, AgentDefinitionRecord>;
  skillsBySlug: Map<string, SkillRecord>;
  blockedAgentSlugs: Set<string>;
  blockedSkillSlugs: Set<string>;
}

/**
 * Install/update slug occupancy includes disabled (retired) definitions. A retired
 * row still holds the workbench unique `(workbenchId, slug)` slot — preview reports
 * `keep_existing` and apply skips rather than silently re-enabling the definition.
 */
async function definitionSlugOccupied(
  tx: PackageWriteTransaction,
  workbenchId: string,
  kind: "agent" | "skill",
  slug: string,
): Promise<boolean> {
  if (kind === "agent") {
    return (await tx.findAgentDefinitionAnyState(workbenchId, slug)) != null;
  }
  return (await tx.findSkillDefinitionAnyState(workbenchId, slug)) != null;
}

export interface ImportMarsPackageInput {
  workbenchId: string;
  sourceDir: string;
  repository: PackageRepository;
  fetcher: MarsPackageFetcher;
  /** Commit SHA for the root fetched source — persisted on the install row. */
  sourceCommitSha?: string | null;
  /** When set, stored on the root package install's `sourcePath` (e.g. GitHub URL). */
  sourcePathOverride?: string;
  /** When set, stored on the root package install's `sourceRef` (GitHub branch/tag/SHA). */
  sourceRef?: string | null;
}

export interface PackageImportPreview {
  packageName: string;
  version: string | null;
  description: string | null;
  agents: PackagePreviewAgent[];
  skills: PackagePreviewSkill[];
  collisions: PackagePreviewCollision[];
  includesSetupInstructions: boolean;
  skippedPackages: string[];
}

export interface PackageUpdatePreview {
  packageName: string;
  currentVersion: string | null;
  upstreamVersion: string | null;
  upstreamCommitSha: string | null;
  willUpdate: PackageUpdateWillUpdateItem[];
  willKeep: PackageUpdateWillKeepItem[];
  willRemove: PackageUpdateWillUpdateItem[];
  willRetire: PackageUpdateWillRetireItem[];
  updateAvailable: boolean;
}

/**
 * Import a Mars package (and its dependencies) into a workbench.
 *
 * Resolves the dependency graph through `resolvePackageGraph` (outside the
 * transaction — parse-only, no writes), then writes everything atomically
 * inside `writePackageGraph`. The split ensures that parse failures don't
 * leave partial state in the repository.
 */
export async function importLocalMarsPackage(
  input: ImportMarsPackageInput,
): Promise<PackageImportResult> {
  const cleanups: Array<() => Promise<void>> = [];
  try {
    const graph = await resolvePackageGraph({
      sourceDir: input.sourceDir,
      repository: input.repository,
      workbenchId: input.workbenchId,
      fetcher: input.fetcher,
      cleanups,
      sourceCommitSha: input.sourceCommitSha ?? null,
    });
    const rootPackageName = graph.at(-1)?.source.manifest.package.name;
    return await input.repository.transaction(async (tx) =>
      writePackageGraph(tx, input.workbenchId, graph, {
        sourcePathOverrides:
          input.sourcePathOverride && rootPackageName
            ? new Map([[rootPackageName, input.sourcePathOverride]])
            : undefined,
        sourceRefOverrides:
          input.sourceRef && rootPackageName
            ? new Map([[rootPackageName, input.sourceRef]])
            : undefined,
      }),
    );
  } catch (error) {
    if (isPackageImportError(error)) throw error;
    throw packageImportError(error instanceof Error ? error.message : "Package import failed");
  } finally {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
  }
}

export async function previewLocalMarsPackageImport(input: {
  workbenchId: string;
  sourceDir: string;
  repository: PackageRepository;
  fetcher: MarsPackageFetcher;
  sourceCommitSha?: string | null;
}): Promise<PackageImportPreview> {
  const cleanups: Array<() => Promise<void>> = [];
  try {
    const graph = await resolvePackageGraph({
      sourceDir: input.sourceDir,
      repository: input.repository,
      workbenchId: input.workbenchId,
      fetcher: input.fetcher,
      cleanups,
      sourceCommitSha: input.sourceCommitSha ?? null,
    });
    const root = graph.at(-1);
    if (!root) {
      throw packageImportError("Package source resolved to an empty graph");
    }
    const includesSetupInstructions = await bootstrapMdExists(root.source.sourceDir);
    return await input.repository.transaction(async (tx) =>
      simulateImportPlan(tx, input.workbenchId, graph, includesSetupInstructions),
    );
  } catch (error) {
    if (isPackageImportError(error)) throw error;
    throw packageImportError(error instanceof Error ? error.message : "Package preview failed");
  } finally {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
  }
}

export async function previewLocalMarsPackageUpdate(input: {
  workbenchId: string;
  sourceDir: string;
  repository: PackageRepository;
  packageInstallId: string;
  upstreamCommitSha?: string | null;
}): Promise<PackageUpdatePreview> {
  const source = await parseMarsPackageSource(input.sourceDir);
  return input.repository.transaction(async (tx) => {
    const installs = await tx.listPackageInstalls(input.workbenchId);
    const packageInstall = installs.find((row) => row.id === input.packageInstallId);
    if (!packageInstall) {
      throw packageImportError(`Package install not found: ${input.packageInstallId}`);
    }
    if (packageInstall.packageName !== source.manifest.package.name) {
      throw packageImportError(
        `Package name mismatch: install is "${packageInstall.packageName}", source is "${source.manifest.package.name}"`,
      );
    }

    const existingAgents = new Map(
      (await tx.listPackageAgents(packageInstall.id)).map((agent) => [agent.slug, agent]),
    );
    const existingSkills = new Map(
      (await tx.listPackageSkills(packageInstall.id)).map((skill) => [skill.slug, skill]),
    );
    const skippedLocalAgents = [...existingAgents.values()].filter((agent) => !isPristine(agent));
    const preservedAgents = preservedAgentGraph(source, existingAgents, skippedLocalAgents);

    const preview: PackageUpdatePreview = {
      packageName: packageInstall.packageName,
      currentVersion: packageInstall.version ?? null,
      upstreamVersion: source.manifest.package.version ?? null,
      upstreamCommitSha: input.upstreamCommitSha ?? packageInstall.sourceCommitSha ?? null,
      willUpdate: [],
      willKeep: [],
      willRemove: [],
      willRetire: [],
      updateAvailable: false,
    };

    for (const skill of source.skills) {
      const existing = existingSkills.get(skill.slug);
      if (existing) {
        if (isPristine(existing)) {
          preview.willUpdate.push({ slug: skill.slug, kind: "skill" });
        } else {
          preview.willKeep.push({ slug: skill.slug, kind: "skill" });
        }
        continue;
      }
      if (await definitionSlugOccupied(tx, input.workbenchId, "skill", skill.slug)) {
        preview.willKeep.push({ slug: skill.slug, kind: "skill" });
        continue;
      }
      preview.willUpdate.push({ slug: skill.slug, kind: "skill" });
    }

    for (const agent of source.agents) {
      const existing = existingAgents.get(agent.slug);
      if (existing) {
        if (isPristine(existing)) {
          preview.willUpdate.push({ slug: agent.slug, kind: "agent" });
        } else {
          preview.willKeep.push({ slug: agent.slug, kind: "agent" });
        }
        continue;
      }
      if (await definitionSlugOccupied(tx, input.workbenchId, "agent", agent.slug)) {
        preview.willKeep.push({ slug: agent.slug, kind: "agent" });
        continue;
      }
      preview.willUpdate.push({ slug: agent.slug, kind: "agent" });
    }

    const incomingSkills = new Set(source.skills.map((skill) => skill.slug));
    for (const [slug, skill] of existingSkills) {
      if (incomingSkills.has(slug)) continue;
      if (preservedAgents.some((agent) => agentReferencesSkill(agent, slug))) {
        preview.willKeep.push({ slug, kind: "skill" });
        continue;
      }
      if (isPristine(skill)) {
        if (await hasRevisionHistoryBeyondPristine(tx, "skill", skill.id)) {
          preview.willRetire.push({ slug, kind: "skill" });
        } else {
          preview.willRemove.push({ slug, kind: "skill" });
        }
      } else {
        preview.willKeep.push({ slug, kind: "skill" });
      }
    }

    const incomingAgents = new Set(source.agents.map((agent) => agent.slug));
    const preservedAgentSlugs = new Set(preservedAgents.map((agent) => agent.slug));
    for (const [slug, agent] of existingAgents) {
      if (incomingAgents.has(slug)) continue;
      if (preservedAgentSlugs.has(slug)) {
        preview.willKeep.push({ slug, kind: "agent" });
        continue;
      }
      if (isPristine(agent)) {
        if (await hasRevisionHistoryBeyondPristine(tx, "agent", agent.id)) {
          preview.willRetire.push({ slug, kind: "agent" });
        } else {
          preview.willRemove.push({ slug, kind: "agent" });
        }
      } else {
        preview.willKeep.push({ slug, kind: "agent" });
      }
    }

    preview.updateAvailable =
      preview.currentVersion !== preview.upstreamVersion ||
      preview.willUpdate.length > 0 ||
      preview.willRemove.length > 0 ||
      preview.willRetire.length > 0;

    return preview;
  });
}

export async function updateLocalMarsPackage(input: {
  workbenchId: string;
  sourceDir: string;
  repository: PackageRepository;
  forceReset?: boolean;
}): Promise<PackageUpdateResult> {
  const source = await parseMarsPackageSource(input.sourceDir);
  return input.repository.transaction(async (tx) => {
    const packageInstall = await tx.findPackageInstall(
      input.workbenchId,
      source.manifest.package.name,
    );
    if (!packageInstall) return emptyUpdateResult();

    await tx.updatePackageInstall(packageInstall.id, localPackageInstallUpdate(source));

    const existingAgents = new Map(
      (await tx.listPackageAgents(packageInstall.id)).map((agent) => [agent.slug, agent]),
    );
    const existingSkills = new Map(
      (await tx.listPackageSkills(packageInstall.id)).map((skill) => [skill.slug, skill]),
    );
    const lookup: LinkLookup = {
      agentsBySlug: new Map(existingAgents),
      skillsBySlug: new Map(existingSkills),
      blockedAgentSlugs: new Set(),
      blockedSkillSlugs: new Set(),
    };
    const relinkAgents: Array<{ parsed: ParsedAgentDefinition; record: AgentDefinitionRecord }> =
      [];
    const result = emptyUpdateResult(packageInstall);
    const skippedLocalAgents = input.forceReset
      ? []
      : [...existingAgents.values()].filter((agent) => !isPristine(agent));
    const preservedAgents = preservedAgentGraph(source, existingAgents, skippedLocalAgents);

    await reconcileSkills(
      tx,
      input.workbenchId,
      packageInstall.id,
      source,
      existingSkills,
      lookup,
      result,
      input.forceReset,
    );
    await reconcileAgents(
      tx,
      input.workbenchId,
      packageInstall.id,
      source,
      existingAgents,
      lookup,
      relinkAgents,
      result,
      input.forceReset,
    );
    await pruneRemovedSkills(
      tx,
      source,
      existingSkills,
      preservedAgents,
      lookup,
      result,
      input.forceReset,
    );
    await pruneRemovedAgents(
      tx,
      source,
      existingAgents,
      preservedAgents,
      lookup,
      result,
      input.forceReset,
    );

    for (const agent of relinkAgents) {
      await replaceAgentLinks(tx, input.workbenchId, agent.record, agent.parsed, lookup);
    }

    return result;
  });
}

async function reconcileSkills(
  tx: PackageWriteTransaction,
  workbenchId: string,
  packageInstallId: string,
  source: ParsedMarsPackageSource,
  existingSkills: Map<string, SkillRecord>,
  lookup: LinkLookup,
  result: PackageUpdateResult,
  forceReset = false,
): Promise<void> {
  for (const skill of source.skills) {
    const existing = existingSkills.get(skill.slug);
    if (existing) {
      if (forceReset || isPristine(existing)) {
        const updated = {
          ...existing,
          body: skill.body,
          meta: skill.meta,
          files: skill.files,
          originalContentChecksum: definitionContentChecksum(skill),
        };
        await tx.updateSkill(existing.id, skillUpdate(skill));
        await seedInitialSkillRevision(tx, updated);
        lookup.skillsBySlug.set(skill.slug, updated);
        result.updatedSkills.push(skill.slug);
      } else {
        result.skippedSkills.push(skill.slug);
      }
      continue;
    }

    if (await definitionSlugOccupied(tx, workbenchId, "skill", skill.slug)) {
      lookup.blockedSkillSlugs.add(skill.slug);
      result.skippedSkills.push(skill.slug);
      continue;
    }

    const inserted = await tx.createSkill({
      workbenchId,
      slug: skill.slug,
      body: skill.body,
      meta: skill.meta,
      files: skill.files,
      packageInstallId,
      originalContentChecksum: definitionContentChecksum(skill),
      sourceType: "package",
      enabled: true,
    });
    lookup.skillsBySlug.set(inserted.slug, inserted);
    await seedInitialSkillRevision(tx, inserted);
    result.updatedSkills.push(skill.slug);
  }
}

async function reconcileAgents(
  tx: PackageWriteTransaction,
  workbenchId: string,
  packageInstallId: string,
  source: ParsedMarsPackageSource,
  existingAgents: Map<string, AgentDefinitionRecord>,
  lookup: LinkLookup,
  relinkAgents: Array<{ parsed: ParsedAgentDefinition; record: AgentDefinitionRecord }>,
  result: PackageUpdateResult,
  forceReset = false,
): Promise<void> {
  for (const agent of source.agents) {
    const existing = existingAgents.get(agent.slug);
    if (existing) {
      if (forceReset || isPristine(existing)) {
        const updated = {
          ...existing,
          body: agent.body,
          meta: agent.meta,
          config: source.manifest.agentOverlays[agent.slug] ?? {},
          originalContentChecksum: agentDefinitionContentChecksum({
            body: agent.body,
            meta: agent.meta,
            config: source.manifest.agentOverlays[agent.slug] ?? {},
          }),
        };
        await tx.updateAgentDefinition(existing.id, agentUpdate(agent, source));
        await seedInitialAgentRevision(tx, updated);
        lookup.agentsBySlug.set(agent.slug, updated);
        relinkAgents.push({ parsed: agent, record: updated });
        result.updatedAgents.push(agent.slug);
      } else {
        result.skippedAgents.push(agent.slug);
      }
      continue;
    }

    if (await definitionSlugOccupied(tx, workbenchId, "agent", agent.slug)) {
      lookup.blockedAgentSlugs.add(agent.slug);
      result.skippedAgents.push(agent.slug);
      continue;
    }

    const inserted = await tx.createAgentDefinition({
      workbenchId,
      slug: agent.slug,
      body: agent.body,
      meta: agent.meta,
      config: source.manifest.agentOverlays[agent.slug] ?? {},
      packageInstallId,
      originalContentChecksum: agentDefinitionContentChecksum({
        body: agent.body,
        meta: agent.meta,
        config: source.manifest.agentOverlays[agent.slug] ?? {},
      }),
      sourceType: "package",
      enabled: true,
    });
    lookup.agentsBySlug.set(agent.slug, inserted);
    await seedInitialAgentRevision(tx, inserted);
    relinkAgents.push({ parsed: agent, record: inserted });
    result.updatedAgents.push(agent.slug);
  }
}

async function pruneRemovedSkills(
  tx: PackageWriteTransaction,
  source: ParsedMarsPackageSource,
  existingSkills: Map<string, SkillRecord>,
  preservedAgents: AgentDefinitionRecord[],
  lookup: LinkLookup,
  result: PackageUpdateResult,
  forceReset = false,
): Promise<void> {
  const incoming = new Set(source.skills.map((skill) => skill.slug));
  for (const [slug, skill] of existingSkills) {
    if (incoming.has(slug)) continue;
    if (!forceReset && preservedAgents.some((agent) => agentReferencesSkill(agent, slug))) {
      result.skippedSkills.push(slug);
      continue;
    }
    if (forceReset || isPristine(skill)) {
      if (await hasRevisionHistoryBeyondPristine(tx, "skill", skill.id)) {
        await retireSkillRemovedFromSource(tx, skill);
        lookup.skillsBySlug.delete(slug);
        result.retiredSkills.push(slug);
      } else {
        await tx.deleteSkill(skill.id);
        lookup.skillsBySlug.delete(slug);
        result.removedSkills.push(slug);
      }
    } else {
      result.skippedSkills.push(slug);
    }
  }
}

function agentReferencesSkill(agent: AgentDefinitionRecord, skillSlug: string): boolean {
  return stringsAt(agent.meta.skills).includes(skillSlug);
}

async function pruneRemovedAgents(
  tx: PackageWriteTransaction,
  source: ParsedMarsPackageSource,
  existingAgents: Map<string, AgentDefinitionRecord>,
  preservedAgents: AgentDefinitionRecord[],
  lookup: LinkLookup,
  result: PackageUpdateResult,
  forceReset = false,
): Promise<void> {
  const incoming = new Set(source.agents.map((agent) => agent.slug));
  const preservedAgentSlugs = new Set(preservedAgents.map((agent) => agent.slug));
  for (const [slug, agent] of existingAgents) {
    if (incoming.has(slug)) continue;
    if (!forceReset && preservedAgentSlugs.has(slug)) {
      result.skippedAgents.push(slug);
      continue;
    }
    if (forceReset || isPristine(agent)) {
      if (await hasRevisionHistoryBeyondPristine(tx, "agent", agent.id)) {
        await retireAgentRemovedFromSource(tx, agent);
        lookup.agentsBySlug.delete(slug);
        result.retiredAgents.push(slug);
      } else {
        await tx.deleteAgentDefinition(agent.id);
        lookup.agentsBySlug.delete(slug);
        result.removedAgents.push(slug);
      }
    } else {
      result.skippedAgents.push(slug);
    }
  }
}

function preservedAgentGraph(
  source: ParsedMarsPackageSource,
  existingAgents: Map<string, AgentDefinitionRecord>,
  skippedLocalAgents: AgentDefinitionRecord[],
): AgentDefinitionRecord[] {
  const incoming = new Set(source.agents.map((agent) => agent.slug));
  const preserved = new Map(skippedLocalAgents.map((agent) => [agent.slug, agent]));
  const queue = [...skippedLocalAgents];

  for (const agent of queue) {
    for (const childSlug of stringsAt(agent.meta.subagents)) {
      if (incoming.has(childSlug) || preserved.has(childSlug)) continue;
      const child = existingAgents.get(childSlug);
      if (!child) continue;
      preserved.set(childSlug, child);
      queue.push(child);
    }
  }

  return [...preserved.values()];
}

async function resolvePackageGraph(input: {
  sourceDir: string;
  repository: PackageRepository;
  workbenchId: string;
  fetcher: MarsPackageFetcher;
  cleanups: Array<() => Promise<void>>;
  sourceCommitSha?: string | null;
  seen?: Set<string>;
}): Promise<PackageGraphNode[]> {
  const seen = input.seen ?? new Set<string>();
  const resolvedPath = path.resolve(input.sourceDir);
  if (seen.has(resolvedPath)) return [];
  seen.add(resolvedPath);

  const source = await parseMarsPackageSource(resolvedPath);
  const nodeSha = input.sourceCommitSha ?? null;
  if (await input.repository.findPackageInstall(input.workbenchId, source.manifest.package.name)) {
    return [{ source, sourceCommitSha: nodeSha }];
  }

  const dependencyGraphs = await Promise.all(
    source.manifest.dependencies.map((dependency) =>
      resolveDependencyNode({
        dependency,
        parentDir: resolvedPath,
        repository: input.repository,
        workbenchId: input.workbenchId,
        fetcher: input.fetcher,
        cleanups: input.cleanups,
        seen,
      }),
    ),
  );

  return [
    ...dependencyGraphs.flat(),
    {
      source,
      sourceCommitSha: nodeSha,
    },
  ];
}

async function resolveDependencyNode(input: {
  dependency: MarsDependency;
  parentDir: string;
  repository: PackageRepository;
  workbenchId: string;
  fetcher: MarsPackageFetcher;
  cleanups: Array<() => Promise<void>>;
  seen: Set<string>;
}): Promise<PackageGraphNode[]> {
  if (input.dependency.path) {
    const dependencyDir = path.resolve(input.parentDir, input.dependency.path);
    try {
      await access(dependencyDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw packageDependencyUnresolved(
          input.dependency,
          `Local dependency "${input.dependency.name}" path does not exist: ${dependencyDir}`,
        );
      }
      throw error;
    }
    return resolvePackageGraph({
      sourceDir: dependencyDir,
      repository: input.repository,
      workbenchId: input.workbenchId,
      fetcher: input.fetcher,
      cleanups: input.cleanups,
      seen: input.seen,
    });
  }

  if (input.dependency.url) {
    try {
      const fetched = await input.fetcher.fetch({
        url: input.dependency.url,
        ref: input.dependency.version,
      });
      input.cleanups.push(fetched.cleanup);
      return resolvePackageGraph({
        sourceDir: fetched.sourceDir,
        repository: input.repository,
        workbenchId: input.workbenchId,
        fetcher: input.fetcher,
        cleanups: input.cleanups,
        sourceCommitSha: fetched.commitSha,
        seen: input.seen,
      });
    } catch (error) {
      if (isPackageImportError(error)) throw error;
      const message =
        error instanceof Error
          ? error.message
          : `Failed to fetch dependency "${input.dependency.name}"`;
      throw packageDependencyUnresolved(input.dependency, message);
    }
  }

  throw packageDependencyUnresolved(
    input.dependency,
    `Dependency "${input.dependency.name}" has no path or url source`,
  );
}

async function simulateImportPlan(
  tx: PackageWriteTransaction,
  workbenchId: string,
  graph: PackageGraphNode[],
  includesSetupInstructions: boolean,
): Promise<PackageImportPreview> {
  const root = graph.at(-1);
  if (!root) {
    throw packageImportError("Package source resolved to an empty graph");
  }
  const manifest = root.source.manifest.package;
  const preview: PackageImportPreview = {
    packageName: manifest.name,
    version: manifest.version ?? null,
    description: manifest.description ?? null,
    agents: [],
    skills: [],
    collisions: [],
    includesSetupInstructions,
    skippedPackages: [],
  };
  const seenAgentSlugs = new Set<string>();
  const seenSkillSlugs = new Set<string>();

  for (const node of graph) {
    const nodeManifest = node.source.manifest;
    if (await tx.findPackageInstall(workbenchId, nodeManifest.package.name)) {
      preview.skippedPackages.push(nodeManifest.package.name);
      continue;
    }

    for (const skill of node.source.skills) {
      if (seenSkillSlugs.has(skill.slug)) continue;
      seenSkillSlugs.add(skill.slug);
      const summary = previewSkillSummary(skill);
      if (await definitionSlugOccupied(tx, workbenchId, "skill", skill.slug)) {
        preview.collisions.push({ slug: skill.slug, kind: "skill", action: "keep_existing" });
        continue;
      }
      preview.skills.push(summary);
    }

    for (const agent of node.source.agents) {
      if (seenAgentSlugs.has(agent.slug)) continue;
      seenAgentSlugs.add(agent.slug);
      const summary = previewAgentSummary(agent);
      if (await definitionSlugOccupied(tx, workbenchId, "agent", agent.slug)) {
        preview.collisions.push({ slug: agent.slug, kind: "agent", action: "keep_existing" });
        continue;
      }
      preview.agents.push(summary);
    }
  }

  return preview;
}

async function writePackageGraph(
  tx: PackageWriteTransaction,
  workbenchId: string,
  graph: PackageGraphNode[],
  options: {
    sourcePathOverrides?: Map<string, string>;
    sourceRefOverrides?: Map<string, string>;
  } = {},
): Promise<PackageImportResult> {
  const result: PackageImportResult = {
    installedPackages: [],
    skippedPackages: [],
    insertedAgents: [],
    insertedSkills: [],
    skippedAgents: [],
    skippedSkills: [],
  };

  for (const node of graph) {
    const manifest = node.source.manifest;
    if (await tx.findPackageInstall(workbenchId, manifest.package.name)) {
      result.skippedPackages.push(manifest.package.name);
      continue;
    }

    const packageInstall = await tx.createPackageInstall({
      workbenchId,
      ...localPackageInstallUpdate(node.source, {
        sourcePathOverride: options.sourcePathOverrides?.get(manifest.package.name),
      }),
      packageName: manifest.package.name,
      sourceRef: options.sourceRefOverrides?.get(manifest.package.name) ?? null,
      sourceCommitSha: node.sourceCommitSha,
      visibility: packageVisibility(manifest),
    });
    result.installedPackages.push(packageInstall);

    const lookup: LinkLookup = {
      agentsBySlug: new Map(),
      skillsBySlug: new Map(),
      blockedAgentSlugs: new Set(),
      blockedSkillSlugs: new Set(),
    };

    for (const skill of node.source.skills) {
      if (await definitionSlugOccupied(tx, workbenchId, "skill", skill.slug)) {
        lookup.blockedSkillSlugs.add(skill.slug);
        result.skippedSkills.push(skill.slug);
        continue;
      }
      const inserted = await tx.createSkill({
        workbenchId,
        slug: skill.slug,
        body: skill.body,
        meta: skill.meta,
        files: skill.files,
        packageInstallId: packageInstall.id,
        originalContentChecksum: definitionContentChecksum(skill),
        sourceType: "package",
        enabled: true,
      });
      result.insertedSkills.push(inserted);
      lookup.skillsBySlug.set(inserted.slug, inserted);
      await seedInitialSkillRevision(tx, inserted);
    }

    for (const agent of node.source.agents) {
      if (await definitionSlugOccupied(tx, workbenchId, "agent", agent.slug)) {
        lookup.blockedAgentSlugs.add(agent.slug);
        result.skippedAgents.push(agent.slug);
        continue;
      }
      const inserted = await tx.createAgentDefinition({
        workbenchId,
        slug: agent.slug,
        body: agent.body,
        meta: agent.meta,
        config: manifest.agentOverlays[agent.slug] ?? {},
        packageInstallId: packageInstall.id,
        originalContentChecksum: agentDefinitionContentChecksum({
          body: agent.body,
          meta: agent.meta,
          config: manifest.agentOverlays[agent.slug] ?? {},
        }),
        sourceType: "package",
        enabled: true,
      });
      result.insertedAgents.push(inserted);
      lookup.agentsBySlug.set(inserted.slug, inserted);
      await seedInitialAgentRevision(tx, inserted);
    }

    for (const agent of node.source.agents) {
      const inserted = lookup.agentsBySlug.get(agent.slug);
      if (inserted) await appendAgentLinks(tx, workbenchId, inserted, agent, lookup);
    }
  }

  return result;
}

async function appendAgentLinks(
  tx: PackageWriteTransaction,
  workbenchId: string,
  agent: AgentDefinitionRecord,
  parsed: ParsedAgentDefinition,
  lookup: LinkLookup,
): Promise<void> {
  for (const link of await desiredSkillLinks(tx, workbenchId, agent, parsed, lookup)) {
    await tx.linkAgentSkill(link);
  }
}

async function replaceAgentLinks(
  tx: PackageWriteTransaction,
  workbenchId: string,
  agent: AgentDefinitionRecord,
  parsed: ParsedAgentDefinition,
  lookup: LinkLookup,
): Promise<void> {
  await tx.replaceAgentSkillLinks(
    agent.id,
    await desiredSkillLinks(tx, workbenchId, agent, parsed, lookup),
  );
}

async function desiredSkillLinks(
  tx: PackageWriteTransaction,
  workbenchId: string,
  agent: AgentDefinitionRecord,
  parsed: ParsedAgentDefinition,
  lookup: LinkLookup,
): Promise<AgentSkillLinkRecord[]> {
  const links: AgentSkillLinkRecord[] = [];
  const seenSkillSlugs = new Set<string>();
  let ordinal = 0;
  for (const skillSlug of stringsAt(parsed.meta.skills)) {
    if (seenSkillSlugs.has(skillSlug)) continue;
    seenSkillSlugs.add(skillSlug);
    if (lookup.blockedSkillSlugs.has(skillSlug)) continue;
    const skill =
      lookup.skillsBySlug.get(skillSlug) ?? (await tx.findSkillBySlug(workbenchId, skillSlug));
    if (skill) {
      links.push({
        agentDefinitionId: agent.id,
        skillId: skill.id,
        ordinal,
      });
      ordinal += 1;
    }
  }
  return links;
}

function previewAgentSummary(agent: ParsedAgentDefinition): PackagePreviewAgent {
  return {
    slug: agent.slug,
    name: stringAt(agent.meta.name) ?? agent.slug,
    description: stringAt(agent.meta.description) ?? "",
  };
}

function previewSkillSummary(skill: ParsedSkillDefinition): PackagePreviewSkill {
  return {
    slug: skill.slug,
    name: stringAt(skill.meta.name) ?? skill.slug,
    description: stringAt(skill.meta.description) ?? "",
  };
}

async function bootstrapMdExists(sourceDir: string): Promise<boolean> {
  try {
    await access(path.join(sourceDir, "BOOTSTRAP.md"));
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function localPackageInstallUpdate(
  source: ParsedMarsPackageSource,
  options: { sourcePathOverride?: string } = {},
): Omit<
  PackageInstallRecord,
  "id" | "workbenchId" | "packageName" | "sourceCommitSha" | "sourceRef"
> {
  return {
    sourcePath: options.sourcePathOverride ?? source.sourceDir,
    version: source.manifest.package.version,
    description: source.manifest.package.description,
    visibility: packageVisibility(source.manifest),
  };
}

function packageVisibility(manifest: ParsedMarsPackageSource["manifest"]): PackageVisibility {
  return manifest.package.visibility ?? "private";
}

function skillUpdate(skill: ParsedMarsPackageSource["skills"][number]) {
  return {
    body: skill.body,
    meta: skill.meta,
    files: skill.files,
    originalContentChecksum: definitionContentChecksum(skill),
  };
}

function agentUpdate(agent: ParsedAgentDefinition, source: ParsedMarsPackageSource) {
  const config = source.manifest.agentOverlays[agent.slug] ?? {};
  return {
    body: agent.body,
    meta: agent.meta,
    config,
    originalContentChecksum: agentDefinitionContentChecksum({
      body: agent.body,
      meta: agent.meta,
      config,
    }),
  };
}

function isPristine(record: AgentDefinitionRecord | SkillRecord): boolean {
  if ("config" in record) {
    return (
      record.originalContentChecksum ===
      agentDefinitionContentChecksum({
        body: record.body,
        meta: record.meta,
        config: record.config,
      })
    );
  }
  return record.originalContentChecksum === definitionContentChecksum(record);
}

/** Append-only invariant: never hard-delete rows that accumulated revision history. */
async function hasRevisionHistoryBeyondPristine(
  tx: PackageWriteTransaction,
  kind: "agent" | "skill",
  recordId: string,
): Promise<boolean> {
  const revisions =
    kind === "agent"
      ? await tx.listAgentDefinitionRevisions(recordId)
      : await tx.listSkillDefinitionRevisions(recordId);
  return revisions.length > 1;
}

async function retireAgentRemovedFromSource(
  tx: PackageWriteTransaction,
  agent: AgentDefinitionRecord,
): Promise<void> {
  await tx.updateAgentDefinition(agent.id, {
    body: agent.body,
    meta: { ...agent.meta, removedFromSource: true },
    config: agent.config,
    originalContentChecksum: agent.originalContentChecksum,
    enabled: false,
  });
}

async function retireSkillRemovedFromSource(
  tx: PackageWriteTransaction,
  skill: SkillRecord,
): Promise<void> {
  await tx.updateSkill(skill.id, {
    body: skill.body,
    meta: { ...skill.meta, removedFromSource: true },
    files: skill.files,
    originalContentChecksum: skill.originalContentChecksum,
    enabled: false,
  });
}

function emptyUpdateResult(packageInstall?: PackageInstallRecord): PackageUpdateResult {
  return {
    ...(packageInstall ? { packageInstall } : {}),
    updatedAgents: [],
    updatedSkills: [],
    removedAgents: [],
    removedSkills: [],
    retiredAgents: [],
    retiredSkills: [],
    skippedAgents: [],
    skippedSkills: [],
  };
}
