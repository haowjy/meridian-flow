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
import type { Combined } from "./combine-agents.js";
import {
  type AgentSourceSnapshot,
  type CompiledAgent,
  type CompiledAgentDefinition,
  type CompiledPackage,
  isError,
} from "./compile-package.js";
import { agentRevisionId } from "./helpers.js";
import { PACKAGES_DIR } from "./level-packages.js";
import { agentPath, GRAMMAR_VERSION, skillPath } from "./mars.js";
import {
  type AgentEntry,
  agentsOf,
  createPackageLevels,
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
} from "@meridian/contracts/agents";
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
  /** A built-in file's text by its built-in level path (`AgentFileStatus.path`). */
  builtinFile(path: string): string | undefined;
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
  });

  return {
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
      const current = winners(agentsOf(await levels.saved(userId, projectId))).find(
        (entry) => entry.slug === selection.slug,
      )?.value;
      let row = current && (await rowOf(current.package, current.agent.slug));
      if (!row) {
        // The name is no longer saved (removed or renamed): bind the version the picker showed.
        const builtin = builtinShown.get(selection.definitionRevisionId);
        row = builtin
          ? await rowOf(builtin.package, builtin.slug)
          : await store.readSavedRevision(userId, projectId, selection.definitionRevisionId);
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
    },

    async files(userId, { projectId }) {
      const [all, saves] = await Promise.all([
        levels.fromFiles(userId, projectId),
        levels.readSaves(userId, projectId),
      ]);
      const packages = await statuses(all, saves);
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
        return [
          {
            kind: "agent" as const,
            slug: entry.slug,
            level: entry.level,
            path,
            unavailableReasons: reasonsOf(entry.value.agent, file, false),
            pickable: entry.value.agent.definition ? isPrimary(entry.value.agent.definition) : true,
            shadows: entry.shadows,
            hiddenBy: entry.hiddenBy,
            change: changeOf(entry.level, path),
          },
        ];
      });
      const skills = skillsOf(all).flatMap((entry) => {
        if (!entry.value) return [];
        const file = skillPath(entry.value.slug);
        const path = `${entry.value.folder}${file}`;
        return [
          {
            kind: "skill" as const,
            slug: entry.slug,
            level: entry.level,
            path,
            unavailableReasons: entry.value.diagnostics
              .filter(isError)
              .map((item) => (item.file === file ? item.message : `${item.file}: ${item.message}`)),
            pickable: listingOf(entry)?.userInvocable ?? true,
            shadows: entry.shadows,
            hiddenBy: entry.hiddenBy,
            change: changeOf(entry.level, path),
          },
        ];
      });
      return { files: [...agents, ...skills], packages };
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
      return winners(skillsOf(await levels.saved(userId, projectId)))
        .map(listingOf)
        .filter((skill): skill is CatalogSkill => skill?.userInvocable === true);
    },

    async resolveSkill(userId, { projectId, slug }) {
      const winner = winners(skillsOf(await levels.saved(userId, projectId))).find(
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
