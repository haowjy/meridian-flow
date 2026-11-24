import type { AgentLevel, AgentsLevel } from "@meridian/contracts/agents";
import type { AgentLevelFiles } from "../ports/agent-level-files.js";
import type { AgentRevisionStore, PackageSave, SaveOwner } from "../ports/agent-revision-store.js";
import { type Combined, type Layered, type LevelItems, layerByName } from "./combine-agents.js";
import {
  type AgentSourceSnapshot,
  type CompiledAgent,
  type CompiledPackage,
  compilePackage,
  type PackageDiagnostic,
  sourceDigest,
} from "./compile-package.js";
import { PACKAGES_DIR, splitLevel } from "./level-packages.js";
import { MANIFEST_PATH, readManifest } from "./mars.js";

export interface AgentEntry {
  package: CompiledPackage;
  agent: CompiledAgent;
  folder: string;
}
export interface SkillEntry {
  package: CompiledPackage;
  slug: string;
  diagnostics: PackageDiagnostic[];
  folder: string;
}

export interface PackageLevel {
  level: AgentLevel;
  root: CompiledPackage | null;
  imports: Array<{ name: string; package: CompiledPackage }>;
}

export const folderOf = (name: string): string => `${PACKAGES_DIR}${name}/`;
const nameOf = (folder: string): string => folder.slice(PACKAGES_DIR.length, -1);

export const filesDigest = (pkg: { coordinate: string; files: Record<string, string> }): string =>
  sourceDigest({ coordinate: pkg.coordinate, files: pkg.files });

const CACHED_PACKAGES = 200;

export function createPackageLevels(input: {
  store: AgentRevisionStore;
  levelFiles: AgentLevelFiles;
  builtins: AgentSourceSnapshot[];
}) {
  const { store } = input;
  const compiled = new Map<string, CompiledPackage>();
  const installed = new Map<string, Awaited<ReturnType<AgentRevisionStore["installSource"]>>>();
  const savedPackages = new Map<string, CompiledPackage>();
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
  const install = async (pkg: CompiledPackage) =>
    installed.get(pkg.contentDigest) ??
    remember(
      installed,
      pkg.contentDigest,
      await store.installSource({ coordinate: pkg.coordinate, files: pkg.files }),
    );

  const builtinPackages = input.builtins.map((source) => ({
    name: readManifest(source.files[MANIFEST_PATH]).fields?.name ?? source.coordinate,
    package: compile(source),
  }));

  const savedPackage = async (packageRevisionId: string): Promise<CompiledPackage | undefined> => {
    const cached = savedPackages.get(packageRevisionId);
    if (cached) return cached;
    const source = await store.readSource(packageRevisionId);
    return source && remember(savedPackages, packageRevisionId, compile(source));
  };

  const ownerOf = (level: AgentsLevel, userId: string, projectId?: string): SaveOwner | null =>
    level === "user" ? { userId } : projectId ? { projectId } : null;

  const readSaves = async (userId: string, projectId?: string) => {
    const read = async (level: AgentsLevel) => {
      const owner = ownerOf(level, userId, projectId);
      return owner ? await store.readSaved(owner) : [];
    };
    const [user, project] = await Promise.all([read("user"), read("project")]);
    return { user, project };
  };
  type Saves = Awaited<ReturnType<typeof readSaves>>;

  async function fromFiles(userId: string, projectId: string | undefined) {
    const read = async (level: AgentsLevel) =>
      splitLevel(level, await input.levelFiles.read({ level, userId, projectId }));
    const [user, project] = await Promise.all([read("user"), read("project")]);
    const compileLevel = (split: typeof user) => ({
      root: split.root ? compile(split.root) : null,
      imports: split.imports.map((item) => ({ name: item.name, package: compile(item.source) })),
    });
    return levelsOf({ user: compileLevel(user), project: compileLevel(project) });
  }

  async function fromSaves(saves: Saves) {
    const compileLevel = async (list: PackageSave[]) => {
      const packages = await Promise.all(
        list.map(async (save) => ({
          folder: save.folder,
          package: save.packageRevisionId ? await savedPackage(save.packageRevisionId) : undefined,
        })),
      );
      return {
        root: packages.find((item) => item.folder === "")?.package ?? null,
        imports: packages.flatMap((item) =>
          item.folder !== "" && item.package
            ? [{ name: nameOf(item.folder), package: item.package }]
            : [],
        ),
      };
    };
    const [user, project] = await Promise.all([
      compileLevel(saves.user),
      compileLevel(saves.project),
    ]);
    return levelsOf({ user, project });
  }

  const levelsOf = (writer: Record<AgentsLevel, Omit<PackageLevel, "level">>): PackageLevel[] => [
    { level: "builtin", root: null, imports: builtinPackages },
    { level: "user", ...writer.user },
    { level: "project", ...writer.project },
  ];

  return {
    compile,
    install,
    builtinPackages,
    savedPackage,
    ownerOf,
    readSaves,
    fromFiles,
    saved: async (userId: string, projectId?: string) =>
      fromSaves(await readSaves(userId, projectId)),
    fromSaves,
  };
}
export type PackageLevels = ReturnType<typeof createPackageLevels>;

function layered<T>(
  all: PackageLevel[],
  pick: (pkg: CompiledPackage, folder: string) => Array<{ name: string; value: T }>,
): Array<Layered<T>> {
  return layerByName(
    all.map(
      (level): LevelItems<T> => ({
        level: level.level,
        root: level.root ? pick(level.root, "") : [],
        imports: level.imports.map((item) => ({
          package: item.name,
          items: pick(item.package, folderOf(item.name)),
        })),
      }),
    ),
  );
}

export const agentsOf = (all: PackageLevel[]) =>
  layered(
    all,
    (pkg, folder): Array<{ name: string; value: AgentEntry }> =>
      pkg.agents.map((agent) => ({ name: agent.slug, value: { package: pkg, agent, folder } })),
  );

export const skillsOf = (all: PackageLevel[]) =>
  layered(
    all,
    (pkg, folder): Array<{ name: string; value: SkillEntry }> =>
      pkg.skills.map(({ slug, diagnostics }) => ({
        name: slug,
        value: { package: pkg, slug, diagnostics, folder },
      })),
  );

export const winners = <T>(items: Array<Layered<T>>): Array<Combined<T>> =>
  items.filter((item) => item.hiddenBy === null);
