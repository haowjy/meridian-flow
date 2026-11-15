/**
 * Save: the one path from a package's files to the version new chats use, for the writer's button
 * and the AI's tool. A package is checked on its own. An error in one Agent's or skill's file
 * leaves that item out of what runs and the rest saves; only an error in `mars.toml`, which leaves
 * nothing readable, fails the Save and keeps the previous saved version. Also what the Agents tab says of each
 * package (`statuses`), which is computed from the files and the latest Save, never stored.
 */
import type {
  AgentFileChange,
  AgentFinding,
  AgentPackageStatus,
  AgentsLevel,
  SaveOutcome,
} from "@meridian/contracts/agents";
import type { AgentLevelFiles } from "../ports/agent-level-files.js";
import type { AgentRevisionStore, PackageSave } from "../ports/agent-revision-store.js";
import { checkPackage } from "./check-package.js";
import type { CompiledPackage } from "./compile-package.js";
import { defaultManifest } from "./level-packages.js";
import { MANIFEST_PATH } from "./mars.js";
import { mergeText } from "./merge-text.js";
import {
  agentsOf,
  filesDigest,
  folderOf,
  type PackageLevel,
  type PackageLevels,
  winners,
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
  /**
   * Saves the version before `saveId` again and puts the package's files back by a three-way merge
   * (base: that Save's text, live: the files now, target: the previous save's text), so an edit
   * made since survives. `undone` is false when a later Save exists: nothing changes.
   */
  undoSave(
    userId: string,
    input: { projectId?: string; level: AgentsLevel; saveId: string },
  ): Promise<{ undone: boolean }>;
}

/** Warnings that say an Agent may run wider than its file reads come first on a Save's result. */
const _isLostRestriction = (item: AgentFinding) =>
  /^field\.(restriction-lost|execution-ignored|set-aside)$/.test(item.code);

const WRITER_LEVELS = ["user", "project"] as const;

/** What changed from `before` to `after`, as level-relative paths under `folder`. */
/** The files the writer has: the manifest `splitLevel` makes for a level's own files is not one. */
function writtenFiles(
  files: Record<string, string> | undefined,
  level: AgentsLevel,
  folder: string,
): Record<string, string> {
  const { [MANIFEST_PATH]: manifest, ...rest } = files ?? {};
  return folder === "" && manifest === defaultManifest(level)
    ? rest
    : { ...rest, ...(manifest === undefined ? {} : { [MANIFEST_PATH]: manifest }) };
}

function changesOf(
  before: Record<string, string> | undefined,
  after: Record<string, string> | undefined,
  level: AgentsLevel,
  folder: string,
): AgentFileChange[] {
  const was = writtenFiles(before, level, folder);
  const now = writtenFiles(after, level, folder);
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

export function createPackageSaver(input: {
  store: AgentRevisionStore;
  levels: PackageLevels;
  levelFiles: AgentLevelFiles;
}) {
  const { store, levels, levelFiles } = input;
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
            : check && check.blocking.length > 0
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
          changes: changesOf(await savedFiles(saved), pkg?.files, level, folder),
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

      /** Each saved Agent name and whether it is a usable Agent (false: a name two packages bring). */
      const namesOf = (all: PackageLevel[]) =>
        new Map(winners(agentsOf(all)).map((entry) => [entry.slug, entry.value !== null]));

      const outcomes: SaveOutcome[] = [];
      let before = namesOf(await levels.fromSaves(saves));
      for (const { level, folder } of targets) {
        const owner = levels.ownerOf(level, userId, projectId);
        if (!owner) continue;
        const pkg = packagesOf(all.find((item) => item.level === level)).get(folder);
        const latest = saves[level].find((item) => item.folder === folder);
        const saved = latest?.packageRevisionId ? latest : undefined;
        if (!pkg && !saved) continue;
        const changes = changesOf(await savedFiles(saved), pkg?.files, level, folder);
        const check = pkg ? checkPackage(pkg) : undefined;
        const shown = (check?.findings ?? []).map(findingOf);
        const base = { level, folder, changes, leftOut: check?.leftOut ?? [], renamed: [] };
        if (check && check.blocking.length > 0) {
          outcomes.push({
            ...base,
            outcome: "failed",
            findings: shown.filter((item) => item.severity === "error"),
          });
          continue;
        }
        if (pkg && saved && filesDigest(pkg) === saved.contentDigest) {
          outcomes.push({ ...base, outcome: "unchanged", findings: shown });
          continue;
        }
        const revision = pkg ? await levels.install(pkg) : undefined;
        const row = await store.savePackage(owner, folder, revision?.packageRevisionId ?? null);
        saves[level] = [...saves[level].filter((item) => item.folder !== folder), row];
        const after = namesOf(await levels.fromSaves(saves));
        outcomes.push({
          ...base,
          outcome: "saved",
          saveId: row.id,
          findings: shown,
          renamed: [...before].flatMap(([slug, usable]) => {
            // A name two packages bring stays as an unavailable item; both Agents are renamed.
            const names = [...after.keys()].filter(
              (name) => name.startsWith(`${slug}__`) && !before.has(name),
            );
            return usable && after.get(slug) === false && names.length > 0
              ? [`${slug} is now ${names.join(", ")}`]
              : [];
          }),
        });
        before = after;
      }
      return outcomes;
    },

    async undoSave(userId, { projectId, level, saveId }) {
      const owner = levels.ownerOf(level, userId, projectId);
      const result = owner ? await store.undoSave(owner, saveId) : undefined;
      if (!result?.undone) return { undone: false };
      const { undone, current } = result;
      // The files go back by the content merge Apply and Un-Apply use: an edit made since survives.
      const folder = undone.folder;
      if (projectId || level === "project") {
        const live = (await levels.fromFiles(userId, projectId)).find(
          (item) => item.level === level,
        );
        const was = writtenFiles(await savedFiles(undone), level, folder);
        const target = writtenFiles(await savedFiles(current), level, folder);
        const now = writtenFiles(packagesOf(live).get(folder)?.files, level, folder);
        const restore: Record<string, string | null> = {};
        for (const path of new Set([
          ...Object.keys(was),
          ...Object.keys(target),
          ...Object.keys(now),
        ])) {
          const [b, l, t] = [was[path], now[path], target[path]];
          if (l === t || t === b) continue;
          if (l === b) restore[`${folder}${path}`] = t ?? null;
          else if (l !== undefined && t !== undefined) {
            const merged = mergeText({ base: b ?? "", live: l, target: t });
            if (merged !== l) restore[`${folder}${path}`] = merged;
          }
        }
        if (Object.keys(restore).length > 0 && projectId) {
          await levelFiles.writeFiles({ level, userId, projectId, files: restore });
        }
      }
      return { undone: true };
    },
  };
  return { ...saver, statuses };
}
