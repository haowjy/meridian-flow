/**
 * The catalog the writer sees, computed from the levels' files at the moment it is asked, and the
 * binding of a chat to one Agent of it. Nothing is published: an edit to a file is the change.
 */
import type {
  AgentCatalog,
  AgentCatalogItem,
  AgentLevel,
  AgentSelection,
  ResolvedAgentConfiguration,
  RetainedSkillReference,
} from "@meridian/contracts/agents";
import type { AgentLevelFiles } from "../ports/agent-level-files.js";
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
import { type Combined, combineByName, type LevelItems } from "./combine-agents.js";
import {
  type AgentSourceSnapshot,
  type CompiledAgent,
  type CompiledAgentDefinition,
  type CompiledPackage,
  compilePackage,
  sourceDigest,
} from "./compile-package.js";
import { splitLevel } from "./level-packages.js";
import { GRAMMAR_VERSION, MANIFEST_PATH, readManifest, skillPath } from "./mars.js";
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
}
/** A skill of one compiled package; one with a diagnostic is held but never offered. */
interface SkillEntry {
  package: CompiledPackage;
  slug: string;
  available: boolean;
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
  const remember = <V>(cache: Map<string, V>, key: string, value: V): V => {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > CACHED_PACKAGES) cache.delete(cache.keys().next().value as string);
    return value;
  };
  const compile = (source: AgentSourceSnapshot): CompiledPackage => {
    const digest = sourceDigest(source);
    return compiled.get(digest) ?? remember(compiled, digest, compilePackage(source));
  };
  /** Retains a package the first time this process binds from it; later binds find it in `installed`. */
  const install = async (pkg: CompiledPackage) =>
    installed.get(pkg.contentDigest) ??
    remember(installed, pkg.contentDigest, await store.installSource(pkg));

  const builtinPackages = input.builtins.map((source) => ({
    name: readManifest(source.files[MANIFEST_PATH]).fields?.name ?? source.coordinate,
    package: compile(source),
  }));

  /** The three levels' packages, lowest first, compiled from the files as they are now. */
  async function levels(userId: string, projectId: string | undefined) {
    const read = async (level: "user" | "project") =>
      splitLevel(level, await input.levelFiles.read({ level, userId, projectId }));
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

  const agentsOf = (all: Levels): Array<Combined<AgentEntry>> => {
    const items = (pkg: CompiledPackage) =>
      pkg.agents.map((agent) => ({ name: agent.slug, value: { package: pkg, agent } }));
    return combineByName(
      all.map(
        (level): LevelItems<AgentEntry> => ({
          level: level.level,
          root: level.root ? items(level.root) : [],
          imports: level.imports.map((item) => ({
            package: item.name,
            items: items(item.package),
          })),
        }),
      ),
    );
  };
  const skillsOf = (all: Levels): Array<Combined<SkillEntry>> => {
    const items = (pkg: CompiledPackage) =>
      pkg.skills.map(({ slug, diagnostics }) => ({
        name: slug,
        value: { package: pkg, slug, available: diagnostics.length === 0 },
      }));
    return combineByName(
      all.map(
        (level): LevelItems<SkillEntry> => ({
          level: level.level,
          root: level.root ? items(level.root) : [],
          imports: level.imports.map((item) => ({
            package: item.name,
            items: items(item.package),
          })),
        }),
      ),
    );
  };

  /** Why an Agent cannot start a conversation: what the compile found, then what the host adds. */
  const reasonsOf = (agent: Pick<CompiledAgent, "definition" | "diagnostics">): string[] => {
    const { definition } = agent;
    if (!definition) {
      return agent.diagnostics
        .filter((item) => item.severity === "error" || !item.code.startsWith("flow."))
        .map((item) => `${item.file}: ${item.message}`);
    }
    if (
      definition.metadata.mode === "subagent" ||
      definition.metadata["user-invocable"] === false
    ) {
      return ["This Agent is unavailable for primary conversations"];
    }
    const model = definition.metadata.model ?? input.defaultModel();
    if (!model) return ["No configured default model is available."];
    return input.unavailableReasons(definition, model);
  };

  /** The item a writer sees; retaining the package is what gives the Agent a revision to pick. */
  const itemOf = async (entry: Combined<AgentEntry>): Promise<AgentCatalogItem> => {
    const found = entry.value?.agent;
    const row =
      entry.value && found
        ? (await install(entry.value.package)).definitions.find(
            (definition) => definition.slug === found.slug,
          )
        : undefined;
    return {
      selection: row ? { slug: entry.slug, definitionRevisionId: row.id } : null,
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
    entry.value?.available
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
      const items = await Promise.all(agentsOf(await levels(userId, projectId)).map(itemOf));
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

    async resolvePrimary(_userId, selection) {
      // The picker showed this revision, so this is the one that binds, whatever the files say now.
      let row = await store.readCatalogRevision(selection.definitionRevisionId);
      if (!row) return { ok: false, reason: "not-found", details: [] };
      if (row.grammarVersion !== GRAMMAR_VERSION) {
        // Read by an older reader: read the same files again with this one.
        const source = await store.readSource(row.packageRevisionId);
        const again = source && (await store.installSource(source)).definitions;
        row = again?.find((definition) => definition.slug === row?.slug) ?? row;
      }
      const reasons = reasonsOf(row);
      const revision = availableRevision(row);
      if (!revision || reasons.length) {
        return { ok: false, reason: "unavailable", details: reasons };
      }
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

    async userSkills(userId, { projectId }) {
      return skillsOf(await levels(userId, projectId))
        .map(listingOf)
        .filter((skill): skill is CatalogSkill => skill !== null && skill.userInvocable);
    },

    async resolveSkill(userId, { projectId, slug }) {
      const winner = skillsOf(await levels(userId, projectId)).find((entry) => entry.slug === slug);
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
