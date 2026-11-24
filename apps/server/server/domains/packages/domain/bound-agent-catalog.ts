import type {
  AgentCatalog,
  AgentCatalogItem,
  AgentFiles,
  AgentLevel,
  AgentSelection,
  AgentsLevel,
  ResolvedAgentConfiguration,
  RetainedSkillReference,
  ThreadAgent,
} from "@meridian/contracts/agents";
import type { AgentLevelFiles } from "../ports/agent-level-files.js";
import type {
  AgentRevision,
  AgentRevisionBinding,
  AgentRevisionStore,
  CatalogRevision,
} from "../ports/agent-revision-store.js";
import {
  AgentConfigurationError,
  resolveAgentConfiguration,
  skillReference,
} from "./agent-configuration.js";
import type { Combined, Layered } from "./combine-agents.js";
import {
  type AgentSourceSnapshot,
  type CompiledAgent,
  type CompiledAgentDefinition,
  type CompiledPackage,
  isError,
} from "./compile-package.js";
import { agentRevisionId, canonicalizeJsonObject } from "./helpers.js";
import { agentPath, GRAMMAR_VERSION, skillPath } from "./mars.js";
import {
  type AgentEntry,
  agentsOf,
  createPackageLevels,
  folderOf,
  type PackageLevels,
  type SkillEntry,
  skillsOf,
  winners,
} from "./package-levels.js";
import { createPackageSaver, type PackageSaver } from "./save-packages.js";
import { type SkillListing, skillListingFromMarkdown } from "./skill-listing.js";

export type {
  AgentCatalogItem as BoundAgentCatalogItem,
  AgentSelection,
  AgentsLevel,
} from "@meridian/contracts/agents";

type SavedLevels = Awaited<ReturnType<PackageLevels["saved"]>>;

export class AgentSelectionError extends Error {
  constructor(public readonly agentRef: string) {
    super(`Agent not found or unavailable: ${agentRef}`);
    this.name = "AgentSelectionError";
  }
}

export interface CatalogSkill extends SkillListing {
  level: AgentLevel;
}

export interface BoundAgentCatalog extends PackageSaver {
  list(userId: string, input: { projectId?: string }): Promise<AgentCatalog>;
  resolvePrimary(
    userId: string,
    selection: AgentSelection,
    projectId?: string,
  ): Promise<
    | { ok: true; revision: AgentRevision; configuration: ResolvedAgentConfiguration }
    | { ok: false; reason: "not-found" | "unavailable"; details: string[] }
  >;
  files(userId: string, input: { projectId?: string }): Promise<AgentFiles>;
  refreshBinding(
    userId: string,
    projectId: string | undefined,
    thread: { id: string; parentThreadId: string | null },
  ): Promise<(AgentRevisionBinding & { revision: AgentRevision }) | undefined>;
  followRemovedModel(
    userId: string,
    projectId: string | undefined,
    thread: { id: string; parentThreadId: string | null },
    bound: AgentRevisionBinding,
  ): Promise<AgentRevisionBinding>;
  boundAgent(
    userId: string,
    projectId: string | undefined,
    thread: { id: string; parentThreadId: string | null },
  ): Promise<ThreadAgent | undefined>;
  savedFile(
    userId: string,
    input: { projectId?: string; level: AgentLevel; path: string },
  ): Promise<string | undefined>;
  userSkills(userId: string, input: { projectId?: string }): Promise<CatalogSkill[]>;
  resolveSkill(
    userId: string,
    input: { projectId?: string; slug: string },
  ): Promise<{ skill: CatalogSkill; reference: RetainedSkillReference } | undefined>;
}

export function createBoundAgentCatalog(input: {
  store: AgentRevisionStore;
  onSaved?: (userId: string, projectId: string | undefined, level: AgentsLevel) => void;
  levelFiles: AgentLevelFiles;
  builtins: AgentSourceSnapshot[];
  modelFor(named?: string): string | undefined;
  unavailableReasons(definition: CompiledAgentDefinition, model: string): string[];
  modelUnavailable(model: string): string[];
}): BoundAgentCatalog {
  const { store } = input;
  const levels: PackageLevels = createPackageLevels(input);
  const { builtinPackages, install } = levels;
  const builtinShown = new Map(
    builtinPackages.flatMap(({ package: pkg }) =>
      pkg.agents.map((agent) => [
        agentRevisionId(pkg, agent.slug, GRAMMAR_VERSION),
        { package: pkg, slug: agent.slug },
      ]),
    ),
  );
  const rowOf = async (pkg: CompiledPackage, slug: string) =>
    (await install(pkg)).definitions.find((definition) => definition.slug === slug);

  const modelOf = (definition: CompiledAgentDefinition) =>
    input.modelFor(definition.metadata.model);

  const reasonsOf = (
    agent: Pick<CompiledAgent, "definition" | "diagnostics">,
    ownFile?: string,
    asPrimary = true,
  ): string[] => {
    const { definition } = agent;
    if (!definition) {
      return agent.diagnostics
        .filter(isError)
        .map((item) => (item.file === ownFile ? item.message : `${item.file}: ${item.message}`));
    }
    if (asPrimary && !isPrimary(definition)) {
      return ["This Agent is unavailable for primary conversations"];
    }
    const model = modelOf(definition);
    if (!model) return ["No configured default model is available."];
    return input.unavailableReasons(definition, model);
  };

  const itemOf = (entry: Combined<AgentEntry>): AgentCatalogItem => {
    const found = entry.value?.agent;
    const id =
      entry.value && found
        ? agentRevisionId(entry.value.package, found.slug, GRAMMAR_VERSION)
        : undefined;
    return {
      selection: id ? { slug: entry.slug, definitionRevisionId: id } : null,
      slug: entry.slug,
      path: id && entry.value && found ? `${entry.value.folder}${agentPath(found.slug)}` : null,
      name: found?.name ?? entry.slug,
      description: found?.description ?? "",
      model: (found?.definition && modelOf(found.definition)) ?? null,
      effort: found?.definition?.metadata.effort ?? null,
      primary: found?.definition ? isPrimary(found.definition) : true,
      level: entry.level,
      shadows: entry.shadows,
      unavailableReasons: found ? reasonsOf(found) : [entry.clash ?? "Unavailable"],
    };
  };

  const listingOf = (entry: Combined<SkillEntry>): CatalogSkill | null =>
    entry.value && !entry.value.diagnostics.some(isError)
      ? {
          ...skillListingFromMarkdown(
            entry.value.package.files[skillPath(entry.value.slug)],
            entry.value.slug,
          ),
          slug: entry.slug,
          level: entry.level,
        }
      : null;

  const { statuses, ...saver } = createPackageSaver({
    store,
    levels,
    levelFiles: input.levelFiles,
    onSaved: input.onSaved,
  });

  const primaryIn = async (
    saved: SavedLevels,
    userId: string,
    selection: AgentSelection,
    projectId: string | undefined,
  ): ReturnType<BoundAgentCatalog["resolvePrimary"]> => {
    const current = winners(agentsOf(saved)).find((entry) => entry.slug === selection.slug)?.value;
    const newest = current ? await rowOf(current.package, current.agent.slug) : undefined;
    const builtin = builtinShown.get(selection.definitionRevisionId);
    const shown = async () =>
      builtin
        ? rowOf(builtin.package, builtin.slug)
        : store.readSavedRevision(userId, projectId, selection.definitionRevisionId);
    const runs = (candidate: CatalogRevision | undefined) =>
      Boolean(candidate?.definition) && reasonsOf(candidate as CatalogRevision).length === 0;
    let row = newest;
    if (!runs(row)) {
      const fallback = await shown();
      row = runs(fallback) ? fallback : (row ?? fallback);
    }
    if (!row) return { ok: false, reason: "not-found", details: [] };
    const reasons = reasonsOf(row);
    if (!row.definition || reasons.length) {
      return { ok: false, reason: "unavailable", details: reasons };
    }
    const revision = availableRevision(row);
    if (!revision) return { ok: false, reason: "not-found", details: [] };
    try {
      const configuration = await resolveAgentConfiguration({
        revision,
        store,
        modelFor: input.modelFor,
      });
      return { ok: true, revision, configuration };
    } catch (error) {
      if (!(error instanceof AgentConfigurationError)) throw error;
      return { ok: false, reason: "unavailable", details: [error.message] };
    }
  };

  const skillIn = async (saved: SavedLevels, slug: string) => {
    const winner = winners(skillsOf(saved)).find((entry) => entry.slug === slug);
    const skill = winner && listingOf(winner);
    if (!winner?.value || !skill?.userInvocable) return undefined;
    const { packageRevisionId } = await install(winner.value.package);
    return {
      skill,
      reference: skillReference(packageRevisionId, winner.value.package.files, winner.value.slug),
    };
  };

  const catalog: BoundAgentCatalog = {
    ...saver,

    async list(userId, { projectId }) {
      const items = winners(agentsOf(await levels.saved(userId, projectId))).map(itemOf);
      const key = (item: AgentCatalogItem) => item.name.normalize("NFC").toLowerCase();
      return {
        agents: items.sort((a, b) =>
          key(a) < key(b)
            ? -1
            : key(a) > key(b)
              ? 1
              : a.slug < b.slug
                ? -1
                : a.slug > b.slug
                  ? 1
                  : 0,
        ),
      };
    },

    async resolvePrimary(userId, selection, projectId) {
      return primaryIn(await levels.saved(userId, projectId), userId, selection, projectId);
    },

    async files(userId, { projectId }) {
      const [all, saves] = await Promise.all([
        levels.fromFiles(userId, projectId),
        levels.readSaves(userId, projectId),
      ]);
      const packages = await statuses(all, saves);
      const savedLevels = await levels.fromSaves(saves);
      const savedAgents = new Map<string, Layered<AgentEntry>>(
        agentsOf(savedLevels).flatMap((entry) =>
          entry.value
            ? [
                [
                  `${entry.level}:${entry.value.folder}${agentPath(entry.value.agent.slug)}`,
                  entry,
                ] as const,
              ]
            : [],
        ),
      );
      const savedSkills = new Map<string, Layered<SkillEntry>>(
        skillsOf(savedLevels).flatMap((entry) =>
          entry.value
            ? [
                [
                  `${entry.level}:${entry.value.folder}${skillPath(entry.value.slug)}`,
                  entry,
                ] as const,
              ]
            : [],
        ),
      );
      const changed = new Map<string, string>(
        packages.flatMap((item) =>
          item.changes.map((change): [string, string] => [
            `${item.level}:${change.path}`,
            change.change,
          ]),
        ),
      );
      const changeOf = (level: AgentLevel, path: string): "added" | "changed" | null => {
        const change = changed.get(`${level}:${path}`);
        return change === "added" || change === "changed" ? change : null;
      };
      const agents = agentsOf(all).flatMap((entry) => {
        if (!entry.value) return [];
        const file = agentPath(entry.value.agent.slug);
        const path = `${entry.value.folder}${file}`;
        const saved = savedAgents.get(`${entry.level}:${path}`);
        const savedAgent = saved?.value?.agent;
        const runtimeOf = (agent: CompiledAgent | undefined) =>
          agent?.definition ? reasonsOf(agent, file, false) : null;
        return [
          {
            kind: "agent" as const,
            slug: entry.slug,
            level: entry.level,
            path,
            unavailableReasons: runtimeOf(entry.value.agent) ?? runtimeOf(savedAgent) ?? [],
            saved: saved !== undefined,
            savedVersionInUse: savedAgent ? reasonsOf(savedAgent, file, false).length === 0 : false,
            pickable: entry.value.agent.definition ? isPrimary(entry.value.agent.definition) : true,
            shadows: saved?.shadows ?? [],
            hiddenBy: saved?.hiddenBy ?? null,
            change: changeOf(entry.level, path),
          },
        ];
      });
      const skills = skillsOf(all).flatMap((entry) => {
        if (!entry.value) return [];
        const file = skillPath(entry.value.slug);
        const path = `${entry.value.folder}${file}`;
        const saved = savedSkills.get(`${entry.level}:${path}`);
        return [
          {
            kind: "skill" as const,
            slug: entry.slug,
            level: entry.level,
            path,
            unavailableReasons: [],
            saved: saved !== undefined,
            savedVersionInUse: saved?.value ? !saved.value.diagnostics.some(isError) : false,
            pickable: listingOf(entry)?.userInvocable ?? true,
            shadows: saved?.shadows ?? [],
            hiddenBy: saved?.hiddenBy ?? null,
            change: changeOf(entry.level, path),
          },
        ];
      });
      return { files: [...agents, ...skills], packages };
    },

    async savedFile(userId, { projectId, level, path }) {
      const folder = /^packages\/[^/]+\//.exec(path)?.[0] ?? "";
      const owner = level === "builtin" ? null : levels.ownerOf(level, userId, projectId);
      const save = owner && (await store.readSaved(owner)).find((row) => row.folder === folder);
      const pkg =
        level === "builtin"
          ? builtinPackages.find((item) => folderOf(item.name) === folder)?.package
          : save?.packageRevisionId
            ? await levels.savedPackage(save.packageRevisionId)
            : undefined;
      const file = path.slice(folder.length);
      return pkg && Object.hasOwn(pkg.files, file) ? pkg.files[file] : undefined;
    },

    async userSkills(userId, { projectId }) {
      return winners(skillsOf(await levels.saved(userId, projectId)))
        .map(listingOf)
        .filter((skill): skill is CatalogSkill => skill?.userInvocable === true);
    },

    async resolveSkill(userId, { projectId, slug }) {
      return skillIn(await levels.saved(userId, projectId), slug);
    },

    async boundAgent(userId, projectId, thread) {
      const bound = await store.readThreadBinding(thread.id);
      if (!bound?.revision) return undefined;
      const { revision } = bound;
      const refreshed = await catalog.refreshBinding(userId, projectId, thread);
      const runs = await effectiveBinding(userId, projectId, thread, bound, { refreshed });
      const agent = runs.revision ?? revision;
      const source = await store.readSource(agent.packageRevisionId);
      const text = source?.files[agentPath(agent.slug)];
      if (text === undefined) return undefined;
      return {
        selection: { slug: agent.slug, definitionRevisionId: agent.id },
        name: agent.definition.metadata.name ?? agent.slug,
        description: agent.definition.metadata.description ?? "",
        text,
        stale:
          refreshed !== undefined &&
          refreshed !== runs &&
          (refreshed.revision?.id !== agent.id ||
            Object.entries(refreshed.invokedSkills).some(
              ([slug, pin]) => pin.contentDigest !== runs.invokedSkills[slug]?.contentDigest,
            )),
        model: runs.configuration.model,
        effort: runs.configuration.effort ?? null,
        unavailableReasons: input.unavailableReasons(agent.definition, runs.configuration.model),
      };
    },

    async followRemovedModel(userId, projectId, thread, bound) {
      const moved = await effectiveBinding(userId, projectId, thread, bound);
      if (moved === bound || !moved.revision) return bound;
      await store.replaceThreadBinding(
        thread.id,
        moved.revision.id,
        moved.configuration,
        moved.invokedSkills,
      );
      return moved;
    },

    async refreshBinding(userId, projectId, thread) {
      const bound = await store.readThreadBinding(thread.id);
      if (!bound?.revision) return undefined;
      return refreshFrom(userId, projectId, thread, bound);
    },
  };
  async function effectiveBinding(
    userId: string,
    projectId: string | undefined,
    thread: { id: string; parentThreadId: string | null },
    bound: AgentRevisionBinding,
    known?: { refreshed: Awaited<ReturnType<typeof refreshFrom>> },
  ): Promise<AgentRevisionBinding> {
    if (!bound.revision || modelStillOffered({ ...bound, revision: bound.revision })) return bound;
    const moved = known ? known.refreshed : await refreshFrom(userId, projectId, thread, bound);
    return moved?.revision ? moved : bound;
  }
  const modelStillOffered = (bound: AgentRevisionBinding & { revision: AgentRevision }) =>
    input.modelUnavailable(bound.configuration.model).length === 0;

  async function refreshFrom(
    userId: string,
    projectId: string | undefined,
    thread: { id: string; parentThreadId: string | null },
    bound: AgentRevisionBinding,
  ): ReturnType<BoundAgentCatalog["refreshBinding"]> {
    const { revision } = bound;
    if (!revision) return undefined;
    if (thread.parentThreadId !== null && modelStillOffered({ ...bound, revision }))
      return undefined;
    const saved = await levels.saved(userId, projectId);
    const newest = await primaryIn(
      saved,
      userId,
      { slug: revision.slug, definitionRevisionId: revision.id },
      projectId,
    );
    let moved: { revision: AgentRevision; configuration: ResolvedAgentConfiguration } | undefined;
    if (newest.ok) {
      const named = newest.revision.definition.metadata.model;
      const holds =
        named !== undefined &&
        named === revision.definition.metadata.model &&
        input.modelUnavailable(bound.configuration.model).length === 0;
      const configuration = holds
        ? { ...newest.configuration, model: bound.configuration.model }
        : newest.configuration;
      if (runsDifferently(bound, { definition: newest.revision.definition, ...configuration })) {
        moved = { revision: newest.revision, configuration };
      }
    }
    const pins: Record<string, RetainedSkillReference> = {};
    for (const slug of Object.keys(bound.invokedSkills)) {
      const skill = await skillIn(saved, slug);
      if (skill && skill.reference.contentDigest !== bound.invokedSkills[slug]?.contentDigest) {
        pins[slug] = skill.reference;
      }
    }
    if (!moved && Object.keys(pins).length === 0) return undefined;
    return {
      revision: moved?.revision ?? revision,
      configuration: moved?.configuration ?? bound.configuration,
      invocationOverlay: bound.invocationOverlay,
      invokedSkills: { ...bound.invokedSkills, ...pins },
    };
  }
  return catalog;
}

function behaviourOf(agent: {
  definition: CompiledAgentDefinition;
  model: string;
  skills: ResolvedAgentConfiguration["skills"];
  namedTargets: ResolvedAgentConfiguration["namedTargets"];
  tools?: string[];
  "disallowed-tools"?: string[];
  effort?: string;
  permission: string;
}): string {
  const { skills, namedTargets, ...rest } = agent;
  const digests = (list: RetainedSkillReference[]) =>
    list.map(({ path, contentDigest }) => ({ path, contentDigest }));
  return JSON.stringify(
    canonicalizeJsonObject({
      ...rest,
      skills: { load: digests(skills.load), available: digests(skills.available) },
      namedTargets: namedTargets.map(({ name }) => name),
    } as never),
  );
}

function runsDifferently(
  bound: { revision: AgentRevision | null; configuration: ResolvedAgentConfiguration },
  next: Parameters<typeof behaviourOf>[0],
): boolean {
  return (
    !bound.revision ||
    behaviourOf({ definition: bound.revision.definition, ...bound.configuration }) !==
      behaviourOf(next)
  );
}

export function isPrimary(definition: CompiledAgentDefinition): boolean {
  return definition.metadata.mode === "primary" && definition.metadata["user-invocable"] !== false;
}

function availableRevision(row: CatalogRevision): AgentRevision | null {
  return row.definition
    ? {
        id: row.id,
        packageRevisionId: row.packageRevisionId,
        slug: row.slug,
        grammarVersion: row.grammarVersion,
        definition: row.definition,
      }
    : null;
}
