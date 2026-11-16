/**
 * The catalog the writer sees, computed from the levels' saved versions, and the binding of a
 * chat to one Agent of it. A package is used only once it is saved (`save-packages.ts`); `files`
 * reads the files besides, to say what each package's state is and what a Save would publish.
 */
import type {
  AgentCatalog,
  AgentCatalogItem,
  AgentFiles,
  AgentLevel,
  AgentSelection,
  AgentsLevel,
  ResolvedAgentConfiguration,
  RetainedSkillReference,
} from "@meridian/contracts/agents";
import { AGENT_EFFORT_CHOICE } from "@meridian/contracts/agents";
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

/** A skill the `/` menu offers or a writer invoked. */
export interface CatalogSkill extends SkillListing {
  level: AgentLevel;
}

export interface BoundAgentCatalog extends PackageSaver {
  /** The saved Agents of the built-in, user and (with `projectId`) project levels. */
  list(userId: string, input: { projectId?: string }): Promise<AgentCatalog>;
  /**
   * Binds the newest saved Agent of the selection's name; the selection's revision id is used
   * only when that name is no longer saved, and only if a Save of this account or project (which
   * the caller has authorized) holds it, or it is a built-in.
   */
  resolvePrimary(
    userId: string,
    selection: AgentSelection,
    projectId?: string,
  ): Promise<
    | { ok: true; revision: AgentRevision; configuration: ResolvedAgentConfiguration }
    | { ok: false; reason: "not-found" | "unavailable"; details: string[] }
  >;
  /**
   * Every level's Agent and skill files as the files are now, with Mars's verdict and what each
   * hides, and every package's Save state.
   */
  files(userId: string, input: { projectId?: string }): Promise<AgentFiles>;
  /**
   * The binding a top-level chat moves onto when it compacts: the newest saved Agent of its name,
   * and each skill the chat invoked pinned again to its newest save, whether or not the Agent
   * moved (a skill no longer saved keeps its pin). A thread with a parent keeps its
   * binding: its configuration came from the resolver that spawned it, with the parent's overrides, and this resolver would rebuild it without them. Undefined to keep the
   * binding: not a top-level chat, the Agent is gone or its newest save can't run and no skill
   * moved, or nothing changed. Writes no binding; the caller writes the result with
   * `replaceThreadBinding`.
   */
  refreshBinding(
    userId: string,
    projectId: string | undefined,
    thread: { id: string; parentThreadId: string | null },
  ): Promise<(AgentRevisionBinding & { revision: AgentRevision }) | undefined>;
  /**
   * The Agent file a chat is bound to, as saved, and whether a newer save of the Agent or of an
   * invoked skill would take over at the chat's next compaction. Undefined for a chat with no Agent file (a generic subagent).
   */
  boundAgent(
    userId: string,
    projectId: string | undefined,
    thread: { id: string; parentThreadId: string | null },
  ): Promise<{ name: string; text: string; stale: boolean } | undefined>;
  /**
   * A file's text as its package's latest Save holds it, by level-relative path
   * (`AgentFileStatus.path`); a built-in's as shipped. Undefined when that version has no such file.
   */
  savedFile(
    userId: string,
    input: { projectId?: string; level: AgentLevel; path: string },
  ): Promise<string | undefined>;
  /** The saved skills a writer can invoke with `/`: built-in, user and project, combined by name. */
  userSkills(userId: string, input: { projectId?: string }): Promise<CatalogSkill[]>;
  /**
   * A saved skill by name for a writer's `/skill`, with the reference that pins the exact files it
   * was read from. Undefined when no level offers it.
   */
  resolveSkill(
    userId: string,
    input: { projectId?: string; slug: string },
  ): Promise<{ skill: CatalogSkill; reference: RetainedSkillReference } | undefined>;
}

export function createBoundAgentCatalog(input: {
  store: AgentRevisionStore;
  onSaved?: (userId: string, projectId: string | undefined, level: AgentsLevel) => void;
  levelFiles: AgentLevelFiles;
  /** The built-in packages, read once at boot. */
  builtins: AgentSourceSnapshot[];
  defaultModel(): string | undefined;
  /** Host-owned routing/support checks, independent of source syntax compilation. */
  unavailableReasons(definition: CompiledAgentDefinition, model: string): string[];
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
  /** The stored row of `slug` in `pkg`, retaining the package's files the first time. */
  const rowOf = async (pkg: CompiledPackage, slug: string) =>
    (await install(pkg)).definitions.find((definition) => definition.slug === slug);

  /** Why an Agent cannot run: its errors, then what the host adds. */
  const reasonsOf = (
    agent: Pick<CompiledAgent, "definition" | "diagnostics">,
    /** The file the reasons are read on: its own findings need no file name. */
    ownFile?: string,
    /** Whether only an Agent a writer can start a conversation with counts as available. */
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
    const model = definition.metadata.model ?? input.defaultModel();
    if (!model) return ["No configured default model is available."];
    return input.unavailableReasons(definition, model);
  };

  /** The item a writer sees; its revision id names the content shown. */
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
      model: found?.definition
        ? (found.definition.metadata.model ?? input.defaultModel() ?? null)
        : null,
      effort: found?.definition?.metadata.effort
        ? AGENT_EFFORT_CHOICE[found.definition.metadata.effort]
        : null,
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
    // The name is no longer saved (removed or renamed) or its newest version cannot run: the
    // version the picker showed still can, so a chat is not refused over a later Save.
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
        defaultModel: input.defaultModel(),
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
      // What the saved versions do: a file's hiding and hidden follow the saved catalog, not the
      // files, and a file with no saved version is not in use at all.
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
        // Only a read Agent has runtime reasons; without one, its Errors are its findings.
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
      const source = await store.readSource(revision.packageRevisionId);
      const text = source?.files[agentPath(revision.slug)];
      if (text === undefined) return undefined;
      return {
        name: revision.definition.metadata.name ?? revision.slug,
        text,
        stale: (await catalog.refreshBinding(userId, projectId, thread)) !== undefined,
      };
    },

    async refreshBinding(userId, projectId, thread) {
      const bound = await store.readThreadBinding(thread.id);
      if (!bound?.revision || thread.parentThreadId !== null) return undefined;
      const saved = await levels.saved(userId, projectId);
      // The bound version is the fallback, so an Agent that is gone or whose newest save can't
      // run resolves to what the chat already has.
      const newest = await primaryIn(
        saved,
        userId,
        { slug: bound.revision.slug, definitionRevisionId: bound.revision.id },
        projectId,
      );
      const moved =
        newest.ok &&
        runsDifferently(bound, { definition: newest.revision.definition, ...newest.configuration })
          ? newest
          : undefined;
      const pins: Record<string, RetainedSkillReference> = {};
      for (const slug of Object.keys(bound.invokedSkills)) {
        const skill = await skillIn(saved, slug);
        if (skill && skill.reference.contentDigest !== bound.invokedSkills[slug]?.contentDigest) {
          pins[slug] = skill.reference;
        }
      }
      if (!moved && Object.keys(pins).length === 0) return undefined;
      return {
        revision: moved?.revision ?? bound.revision,
        configuration: moved?.configuration ?? bound.configuration,
        invocationOverlay: bound.invocationOverlay,
        invokedSkills: { ...bound.invokedSkills, ...pins },
      };
    },
  };
  return catalog;
}

/**
 * What a chat would run: the compiled definition and its configuration, without the ids that
 * name a package version. A Save of other files in the package changes those ids, not this.
 */
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

/**
 * Whether a writer can start a conversation with the Agent: only `mode: primary`. An Agent with no
 * `mode` is a subagent, as `mars agents` lists it.
 */
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
