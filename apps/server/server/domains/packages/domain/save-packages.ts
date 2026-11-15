/**
 * Save: the one path from a package's files to the version new chats use, for the writer's button
 * and the AI's tool. A package is checked on its own: an Error in its files fails its Save and
 * changes nothing, and a Save of another package goes on. Also what the Agents tab says of each
 * package (`statuses`), which is computed from the files and the latest Save, never stored.
 */
import type {
  AgentFileChange,
  AgentFinding,
  AgentPackageStatus,
  AgentsLevel,
  SaveOutcome,
} from "@meridian/contracts/agents";
import type { AgentRevisionStore, PackageSave } from "../ports/agent-revision-store.js";
import { compareAgents, widenedLabel } from "./agent-widening.js";
import { checkPackage, errorsOf } from "./check-package.js";
import type { CompiledPackage } from "./compile-package.js";
import {
  effectiveAgentsOf,
  filesDigest,
  folderOf,
  type PackageLevel,
  type PackageLevels,
} from "./package-levels.js";

export interface PackageSaver {
  /**
   * Saves each package on its own. `"all"` is every package with files or a saved version, in the
   * user's level and, with `projectId`, the project's: a removed import included. The caller has
   * authorized `projectId`.
   */
  savePackages(
    userId: string,
    input: { projectId?: string; packages: "all" | Array<{ level: AgentsLevel; folder: string }> },
  ): Promise<SaveOutcome[]>;
  /** Saves the version before `saveId` again; `undone` is false when a later Save exists. */
  undoSave(
    userId: string,
    input: { projectId?: string; level: AgentsLevel; saveId: string },
  ): Promise<{ undone: boolean }>;
}

const WRITER_LEVELS = ["user", "project"] as const;

/** What changed from `before` to `after`, as level-relative paths under `folder`. */
function changesOf(
  before: Record<string, string> | undefined,
  after: Record<string, string> | undefined,
  folder: string,
): AgentFileChange[] {
  const was = before ?? {};
  const now = after ?? {};
  return [...new Set([...Object.keys(was), ...Object.keys(now)])].sort().flatMap((path) => {
    const change = !Object.hasOwn(was, path)
      ? "added"
      : !Object.hasOwn(now, path)
        ? "deleted"
        : was[path] !== now[path]
          ? "changed"
          : null;
    return change ? [{ path: `${folder}${path}`, change }] : [];
  });
}

const findingOf = (item: AgentFinding): AgentFinding => ({
  file: item.file,
  code: item.code,
  severity: item.severity,
  path: item.path,
  message: item.message,
});

/** The packages the files hold at a level, by folder. */
function packagesOf(level: PackageLevel | undefined): Map<string, CompiledPackage> {
  const packages = new Map<string, CompiledPackage>();
  if (level?.root) packages.set("", level.root);
  for (const item of level?.imports ?? []) packages.set(folderOf(item.name), item.package);
  return packages;
}

const byFolder = (a: string, b: string) =>
  a === b ? 0 : a === "" ? -1 : b === "" ? 1 : a < b ? -1 : 1;

export function createPackageSaver(input: { store: AgentRevisionStore; levels: PackageLevels }) {
  const { store, levels } = input;
  type Saves = Awaited<ReturnType<PackageLevels["readSaves"]>>;

  const savedFiles = async (save: PackageSave | undefined) =>
    save?.packageRevisionId
      ? (await levels.savedPackage(save.packageRevisionId))?.files
      : undefined;

  /** Each package's state, from the files `all` and the latest Saves. */
  async function statuses(all: PackageLevel[], saves: Saves): Promise<AgentPackageStatus[]> {
    const result: AgentPackageStatus[] = [];
    for (const level of WRITER_LEVELS) {
      const here = packagesOf(all.find((item) => item.level === level));
      const folders = new Set([
        ...here.keys(),
        ...saves[level].filter((save) => save.packageRevisionId).map((save) => save.folder),
      ]);
      for (const folder of [...folders].sort(byFolder)) {
        const pkg = here.get(folder);
        const save = saves[level].find((item) => item.folder === folder);
        const saved = save?.packageRevisionId ? save : undefined;
        const check = pkg ? checkPackage(pkg) : undefined;
        const state: AgentPackageStatus["state"] = !pkg
          ? "removed"
          : !saved
            ? "not-saved"
            : check && errorsOf(check).length > 0
              ? "cant-save"
              : filesDigest(pkg) === saved.contentDigest
                ? "saved"
                : "unsaved";
        result.push({
          level,
          folder,
          state,
          savedAt: saved ? saved.createdAt.toISOString() : null,
          saveId: save?.id ?? null,
          changes: changesOf(await savedFiles(saved), pkg?.files, folder),
          findings: (check?.findings ?? []).map(findingOf),
        });
      }
    }
    return result;
  }

  const saver: PackageSaver = {
    async savePackages(userId, { projectId, packages }) {
      const [all, saves] = await Promise.all([
        levels.fromFiles(userId, projectId),
        levels.readSaves(userId, projectId),
      ]);
      const targets =
        packages === "all"
          ? WRITER_LEVELS.flatMap((level) => {
              const folders = new Set([
                ...packagesOf(all.find((item) => item.level === level)).keys(),
                ...saves[level].filter((save) => save.packageRevisionId).map((save) => save.folder),
              ]);
              return [...folders].sort(byFolder).map((folder) => ({ level, folder }));
            })
          : packages;

      /** What each level's saved Agents are now, to compare before and after a Save. */
      const effective = new Map<AgentsLevel, ReturnType<typeof effectiveAgentsOf>>();
      const effectiveSaved = async (level: AgentsLevel) =>
        effective.get(level) ?? effectiveAgentsOf(await levels.saved(userId, projectId), level);

      const outcomes: SaveOutcome[] = [];
      for (const { level, folder } of targets) {
        const owner = levels.ownerOf(level, userId, projectId);
        if (!owner) continue;
        const pkg = packagesOf(all.find((item) => item.level === level)).get(folder);
        const latest = saves[level].find((item) => item.folder === folder);
        const saved = latest?.packageRevisionId ? latest : undefined;
        if (!pkg && !saved) continue;
        const changes = changesOf(await savedFiles(saved), pkg?.files, folder);
        const check = pkg ? checkPackage(pkg) : undefined;
        const errors = check ? errorsOf(check) : [];
        const warnings = (check?.findings ?? []).filter((item) => item.severity === "warning");
        const base = { level, folder, changes, widened: [], renamed: [] };
        if (errors.length > 0) {
          outcomes.push({ ...base, outcome: "failed", findings: errors.map(findingOf) });
          continue;
        }
        if (pkg && saved && filesDigest(pkg) === saved.contentDigest) {
          outcomes.push({ ...base, outcome: "unchanged", findings: warnings.map(findingOf) });
          continue;
        }
        const before = await effectiveSaved(level);
        const revision = pkg ? await levels.install(pkg) : undefined;
        const row = await store.savePackage(owner, folder, revision?.packageRevisionId ?? null);
        saves[level] = [...saves[level].filter((item) => item.folder !== folder), row];
        const after = effectiveAgentsOf(await levels.fromSaves(saves), level);
        effective.clear();
        effective.set(level, after);
        outcomes.push({
          ...base,
          outcome: "saved",
          saveId: row.id,
          findings: warnings.map(findingOf),
          widened: compareAgents(before, after).map(widenedLabel),
          renamed: [...before.keys()].flatMap((slug) => {
            const names = [...after.keys()].filter((name) => name.startsWith(`${slug}__`));
            return !after.has(slug) && names.length > 0
              ? [`${slug} is now ${names.join(", ")}`]
              : [];
          }),
        });
      }
      return outcomes;
    },

    async undoSave(userId, { projectId, level, saveId }) {
      const owner = levels.ownerOf(level, userId, projectId);
      const result = owner ? await store.undoSave(owner, saveId) : undefined;
      return { undone: result?.undone ?? false };
    },
  };
  return { ...saver, statuses };
}
