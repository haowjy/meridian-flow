/**
 * The catalog the writer sees, computed from the levels' files at the moment it is asked, and the
 * binding of a chat to one Agent of it. Nothing is published: an edit to a file is the change.
 */
import type {
  AgentCatalog,
  AgentCatalogItem,
  AgentFiles,
  AgentLevel,
  AgentSelection,
  ResolvedAgentConfiguration,
  RetainedSkillReference,
} from "@meridian/contracts/agents";
import type { AgentLevelFiles, AgentsBranch } from "../ports/agent-level-files.js";
import type {
  AgentRevision,
  AgentRevisionStore,
  CatalogRevision,
} from "../ports/agent-revision-store.js";
import {
  AgentConfigurationError,
  resolveAgentConfiguration,
  skillReference,
} from "./agent-configuration.js";
import { capabilityOf, type EffectiveAgents } from "./agent-widening.js";
import { type Combined, type Layered, type LevelItems, layerByName } from "./combine-agents.js";
import {
  type AgentSourceSnapshot,
  type CompiledAgent,
  type CompiledAgentDefinition,
  type CompiledPackage,
  compilePackage,
  type PackageDiagnostic,
  sourceDigest,
} from "./compile-package.js";
import { PACKAGES_DIR, splitLevel } from "./level-packages.js";
import { agentRevisionId } from "./helpers.js";
import { agentPath, GRAMMAR_VERSION, MANIFEST_PATH, readManifest, skillPath } from "./mars.js";
import { type SkillListing, skillListingFromMarkdown } from "./skill-listing.js";

export type {
  AgentCatalogItem as BoundAgentCatalogItem,
  AgentSelection,
} from "@meridian/contracts/agents";
export class AgentSelectionError extends Error {
  constructor(public readonly agentRef: string) {
    super(`Agent not found or unavailable: ${agentRef}`);
    this.name = "AgentSelectionError";
  }
}

/** An Agent of one compiled package. */
interface AgentEntry {
  package: CompiledPackage;
  agent: CompiledAgent;
  /** The package's folder in its level: `""` for the root, `packages/<name>/` for an import. */
  folder: string;
}
/** A skill of one compiled package; one with a diagnostic is held but never offered. */
interface SkillEntry {
  package: CompiledPackage;
  slug: string;
  diagnostics: PackageDiagnostic[];
  folder: string;
}

/** A skill the `/` menu offers or a writer invoked. */
export interface CatalogSkill extends SkillListing {
  level: AgentLevel;
}

export interface BoundAgentCatalog {
  list(userId: string, input: { projectId?: string }): Promise<AgentCatalog>;
  resolvePrimary(
    userId: string,
    selection: AgentSelection,
    projectId?: string,
  ): Promise<
    | { ok: true; revision: AgentRevision; configuration: ResolvedAgentConfiguration }
    | { ok: false; reason: "not-found" | "unavailable"; details: string[] }
  >;
  /** Every level's Agent and skill files, with Mars's verdict and what each hides. */
  files(userId: string, input: { projectId?: string }): Promise<AgentFiles>;
  /**
   * The Agents a write at `level` can change the meaning of: that level and the levels below it,
   * never the writing Project's full catalog (`subagents` and `skills` resolve only inside their
   * package, so a higher level that has a name keeps its winner whatever `level` holds). `branch`
   * reads the files as that owner's branch holds them, its drafts' text over live's.
   */
  effectiveAgents(
    userId: string,
    input: { projectId?: string; level: "user" | "project"; branch?: AgentsBranch },
  ): Promise<EffectiveAgents>;
  /** A built-in file's text by its built-in level path (`AgentFileStatus.path`). */
  builtinFile(path: string): string | undefined;
  /** The skills a writer can invoke with `/`: built-in, user and project, combined by name. */
  userSkills(userId: string, input: { projectId?: string }): Promise<CatalogSkill[]>;
  /**
   * A skill by name for a writer's `/skill`, with the reference that pins the exact files it was
   * read from. Undefined when no level offers it.
   */
  resolveSkill(
    userId: string,
    input: { projectId?: string; slug: string },
  ): Promise<{ skill: CatalogSkill; reference: RetainedSkillReference } | undefined>;
}

/** Compiled packages kept between reads, by content digest; a level is a few packages. */
const CACHED_PACKAGES = 200;
/** Picker rows remembered across all accounts, each a reference to a cached package. */
const SHOWN_REVISIONS = 5000;

export function createBoundAgentCatalog(input: {
  store: AgentRevisionStore;
  levelFiles: AgentLevelFiles;
  /** The built-in packages, read once at boot. */
  builtins: AgentSourceSnapshot[];
  defaultModel(): string | undefined;
  /** Host-owned routing/support checks, independent of source syntax compilation. */
  unavailableReasons(definition: CompiledAgentDefinition, model: string): string[];
}): BoundAgentCatalog {
  const { store } = input;
  const compiled = new Map<string, CompiledPackage>();
  const installed = new Map<string, Awaited<ReturnType<AgentRevisionStore["installSource"]>>>();
  const remember = <V>(cache: Map<string, V>, key: string, value: V, limit = CACHED_PACKAGES): V => {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > limit) cache.delete(cache.keys().next().value as string);
    return value;
  };
  const compile = (source: AgentSourceSnapshot): CompiledPackage => {
    const digest = sourceDigest(source);
    return compiled.get(digest) ?? remember(compiled, digest, compilePackage(source));
  };
  /**
   * What each account's picker showed, by revision id: a bind takes the revision the picker
   * showed, and only one this account's levels or the built-ins produced. Nothing is retained
   * until a chat binds.
   */
  const shown = new Map<string, { package: CompiledPackage; slug: string }>();
  const shownKey = (userId: string, id: string) => `${userId}:${id}`;
  /** Retains a package the first time this process binds from it; later binds find it in `installed`. */
  const install = async (pkg: CompiledPackage) =>
    installed.get(pkg.contentDigest) ??
    remember(installed, pkg.contentDigest, await store.installSource(pkg));

  const builtinPackages = input.builtins.map((source) => ({
    name: readManifest(source.files[MANIFEST_PATH]).fields?.name ?? source.coordinate,
    package: compile(source),
  }));
  const builtinShown = new Map(
    builtinPackages.flatMap(({ package: pkg }) =>
      pkg.agents.map((agent) => [
        agentRevisionId(pkg, agent.slug, GRAMMAR_VERSION),
        { package: pkg, slug: agent.slug },
      ]),
    ),
  );

  /** The three levels' packages, lowest first, compiled from the files as they are now. */
  async function levels(userId: string, projectId: string | undefined, branch?: AgentsBranch) {
    const read = async (level: "user" | "project") =>
      splitLevel(level, await input.levelFiles.read({ level, userId, projectId, branch }));
    const [user, project] = await Promise.all([read("user"), read("project")]);
    const compileLevel = (split: typeof user) => ({
      root: compile(split.root),
      imports: split.imports.map((item) => ({ name: item.name, package: compile(item.source) })),
    });
    return [
      { level: "builtin" as const, root: null, imports: builtinPackages },
      { level: "user" as const, ...compileLevel(user) },
      { level: "project" as const, ...compileLevel(project) },
    ];
  }
  type Levels = Awaited<ReturnType<typeof levels>>;

  /** Each level's items of `pick`, by name, with the package folder each came from. */
  const layered = <T>(
    all: Levels,
    pick: (pkg: CompiledPackage, folder: string) => Array<{ name: string; value: T }>,
  ): Array<Layered<T>> =>
    layerByName(
      all.map(
        (level): LevelItems<T> => ({
          level: level.level,
          root: level.root ? pick(level.root, "") : [],
          imports: level.imports.map((item) => ({
            package: item.name,
            items: pick(item.package, `${PACKAGES_DIR}${item.name}/`),
          })),
        }),
      ),
    );
  const agentsOf = (all: Levels) =>
    layered(
      all,
      (pkg, folder): Array<{ name: string; value: AgentEntry }> =>
        pkg.agents.map((agent) => ({ name: agent.slug, value: { package: pkg, agent, folder } })),
    );
  const skillsOf = (all: Levels) =>
    layered(
      all,
      (pkg, folder): Array<{ name: string; value: SkillEntry }> =>
        pkg.skills.map(({ slug, diagnostics }) => ({
          name: slug,
          value: { package: pkg, slug, diagnostics, folder },
        })),
    );
  const winners = <T>(items: Array<Layered<T>>): Array<Combined<T>> =>
    items.filter((item) => item.hiddenBy === null);

  /** Why an Agent cannot run: what the compile found, then what the host adds. */
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
        .filter((item) => item.severity === "error" || !item.code.startsWith("flow."))
        .map((item) => (item.file === ownFile ? item.message : `${item.file}: ${item.message}`));
    }
    if (asPrimary && !isPrimary(definition)) {
      return ["This Agent is unavailable for primary conversations"];
    }
    const model = definition.metadata.model ?? input.defaultModel();
    if (!model) return ["No configured default model is available."];
    return input.unavailableReasons(definition, model);
  };

  /** The item a writer sees; its revision id names the content shown, retained when a chat binds. */
  const itemOf = (userId: string, entry: Combined<AgentEntry>): AgentCatalogItem => {
    const found = entry.value?.agent;
    const id =
      entry.value && found
        ? agentRevisionId(entry.value.package, found.slug, GRAMMAR_VERSION)
        : undefined;
    if (id && entry.value && found) {
      remember(
        shown,
        shownKey(userId, id),
        { package: entry.value.package, slug: found.slug },
        SHOWN_REVISIONS,
      );
    }
    return {
      selection: id ? { slug: entry.slug, definitionRevisionId: id } : null,
      slug: entry.slug,
      name: found?.name ?? entry.slug,
      description: found?.description ?? "",
      model: found?.definition
        ? (found.definition.metadata.model ?? input.defaultModel() ?? null)
        : null,
      level: entry.level,
      shadows: entry.shadows,
      unavailableReasons: found ? reasonsOf(found) : [entry.clash ?? "Unavailable"],
    };
  };

  const listingOf = (entry: Combined<SkillEntry>): CatalogSkill | null =>
    entry.value?.diagnostics.length === 0
      ? {
          ...skillListingFromMarkdown(
            entry.value.package.files[skillPath(entry.value.slug)],
            entry.value.slug,
          ),
          slug: entry.slug,
          level: entry.level,
        }
      : null;

  return {
    async list(userId, { projectId }) {
      const items = winners(agentsOf(await levels(userId, projectId))).map((entry) =>
        itemOf(userId, entry),
      );
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

    async effectiveAgents(userId, { projectId, level, branch }) {
      const all = await levels(userId, projectId, branch);
      const scope = level === "user" ? all.filter((each) => each.level !== "project") : all;
      return new Map(
        winners(agentsOf(scope)).map((entry) => [
          entry.slug,
          {
            name: entry.value?.agent.name ?? entry.slug,
            level: entry.level,
            capability: capabilityOf(entry.value?.agent),
          },
        ]),
      );
    },

    async resolvePrimary(userId, selection, projectId) {
      // The picker showed this revision, so this is the one that binds, whatever the files say
      // now. An id this account's picker did not show (the server restarted since, or it is
      // another account's) binds the Agent's current files by name instead.
      const picked =
        shown.get(shownKey(userId, selection.definitionRevisionId)) ??
        builtinShown.get(selection.definitionRevisionId);
      const current = picked
        ? undefined
        : winners(agentsOf(await levels(userId, projectId))).find(
            (entry) => entry.slug === selection.slug,
          )?.value;
      const source = picked ?? (current && { package: current.package, slug: current.agent.slug });
      if (!source) return { ok: false, reason: "not-found", details: [] };
      const agent = source.package.agents.find((each) => each.slug === source.slug);
      if (!agent) return { ok: false, reason: "not-found", details: [] };
      const reasons = reasonsOf(agent);
      if (!agent.definition || reasons.length) {
        return { ok: false, reason: "unavailable", details: reasons };
      }
      // The chat binds, so the files are retained now.
      const row = (await install(source.package)).definitions.find(
        (definition) => definition.slug === source.slug,
      );
      const revision = row && availableRevision(row);
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
    },

    async files(userId, { projectId }) {
      const all = await levels(userId, projectId);
      const agents = agentsOf(all).flatMap((entry) => {
        if (!entry.value) return [];
        const file = agentPath(entry.value.agent.slug);
        return [
          {
            kind: "agent" as const,
            slug: entry.slug,
            level: entry.level,
            path: `${entry.value.folder}${file}`,
            unavailableReasons: reasonsOf(entry.value.agent, file, false),
            pickable: entry.value.agent.definition ? isPrimary(entry.value.agent.definition) : true,
            shadows: entry.shadows,
            hiddenBy: entry.hiddenBy,
          },
        ];
      });
      const skills = skillsOf(all).flatMap((entry) => {
        if (!entry.value) return [];
        const file = skillPath(entry.value.slug);
        return [
          {
            kind: "skill" as const,
            slug: entry.slug,
            level: entry.level,
            path: `${entry.value.folder}${file}`,
            unavailableReasons: entry.value.diagnostics.map((item) =>
              item.file === file ? item.message : `${item.file}: ${item.message}`,
            ),
            pickable: listingOf(entry)?.userInvocable ?? true,
            shadows: entry.shadows,
            hiddenBy: entry.hiddenBy,
          },
        ];
      });
      return { files: [...agents, ...skills] };
    },

    builtinFile(path) {
      if (!path.startsWith(PACKAGES_DIR)) return undefined;
      const inside = path.slice(PACKAGES_DIR.length);
      const slash = inside.indexOf("/");
      const pkg = builtinPackages.find((item) => item.name === inside.slice(0, slash));
      const files = pkg?.package.files;
      const file = inside.slice(slash + 1);
      return files && Object.hasOwn(files, file) ? files[file] : undefined;
    },

    async userSkills(userId, { projectId }) {
      return winners(skillsOf(await levels(userId, projectId)))
        .map(listingOf)
        .filter((skill): skill is CatalogSkill => skill?.userInvocable === true);
    },

    async resolveSkill(userId, { projectId, slug }) {
      const winner = winners(skillsOf(await levels(userId, projectId))).find(
        (entry) => entry.slug === slug,
      );
      const skill = winner && listingOf(winner);
      if (!winner?.value || !skill?.userInvocable) return undefined;
      const { packageRevisionId } = await install(winner.value.package);
      return {
        skill,
        reference: skillReference(packageRevisionId, winner.value.package.files, winner.value.slug),
      };
    },
  };
}

/** Whether a writer can start a conversation with the Agent, not only another Agent call it. */
function isPrimary(definition: CompiledAgentDefinition): boolean {
  return definition.metadata.mode !== "subagent" && definition.metadata["user-invocable"] !== false;
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
