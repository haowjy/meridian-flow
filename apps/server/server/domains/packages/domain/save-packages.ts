/**
 * Save: the one path from a package's files to the version new chats use, for the writer's button
 * and the AI's tool. A package is checked on its own, from one cut of its files. An error in one
 * Agent's or skill's file stops that edit from being used and the rest saves: the item keeps the
 * files of its last saved version when that was usable, and is out of the package otherwise. Only
 * an error in `mars.toml`, which leaves nothing readable, fails the Save and keeps the previous
 * saved version. Also what the Agents tab says of each package (`statuses`), which is computed
 * from the files and the latest Save, never stored.
 */
import {
  type AgentFileChange,
  type AgentFinding,
  type AgentPackageStatus,
  type AgentsLevel,
  type SaveOutcome,
  shownFindings,
  type UndoSaveResponse,
} from "@meridian/contracts/agents";
import type { AgentLevelFiles } from "../ports/agent-level-files.js";
import type { AgentRevisionStore, PackageSave } from "../ports/agent-revision-store.js";
import { checkPackage } from "./check-package.js";
import { type CompiledPackage, isError } from "./compile-package.js";
import { defaultManifest } from "./level-packages.js";
import { agentPath, agentSlugOf, MANIFEST_PATH, skillPath, skillSlugOf } from "./mars.js";
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
    input: {
      by?: "writer" | "ai";
      projectId?: string;
      packages: "all" | Array<{ level: AgentsLevel; folder: string }>;
    },
  ): Promise<SaveOutcome[]>;
  /**
   * Saves the version before `saveId` again and brings the previous save's text into the
   * package's files, each merged under its document's lock against what it holds then (base: that
   * Save's text): an edit made since survives, and the writer's text wins where both changed the
   * same text. A file the previous save lacked or the writer deleted stays as it is. The files and
   * the new Save commit together or not at all. `undone` is false when a later Save exists: nothing changes.
   */
  undoSave(
    userId: string,
    input: { projectId?: string; level: AgentsLevel; saveId: string },
  ): Promise<UndoSaveResponse>;
}

const WRITER_LEVELS = ["user", "project"] as const;

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

const agentSlugOrSkill = (file: string) =>
  agentSlugOf(file) !== undefined || skillSlugOf(file) !== undefined;

const byFolder = (a: string, b: string) =>
  a === b ? 0 : a === "" ? -1 : b === "" ? 1 : a < b ? -1 : 1;

export function createPackageSaver(input: {
  store: AgentRevisionStore;
  levels: PackageLevels;
  levelFiles: AgentLevelFiles;
  onSaved?: (userId: string, projectId: string | undefined, level: AgentsLevel) => void;
}) {
  const { store, levels, levelFiles } = input;
  type Saves = Awaited<ReturnType<PackageLevels["readSaves"]>>;

  const savedPackageOf = async (save: PackageSave | null | undefined) =>
    save?.packageRevisionId ? levels.savedPackage(save.packageRevisionId) : undefined;
  const savedFiles = async (save: PackageSave | null | undefined) =>
    (await savedPackageOf(save))?.files;

  /**
   * What a Save installs for `pkg`: its files, except that an Agent or skill with an error keeps
   * the files of its last saved version when that was usable, so a typo does not take a working
   * Agent away. Items with an error of their own go first: one that only names a broken
   * subagent is usually fixed by that, and keeps the writer's good edit. `kept` are the
   * package-relative paths of the items that kept their saved version.
   */
  function keepLastGood(pkg: CompiledPackage, saved: CompiledPackage | undefined) {
    let effective = pkg;
    const kept: string[] = [];
    if (!saved) return { effective, kept };
    const usable = new Set<string>([
      ...saved.agents.filter((agent) => agent.definition).map((agent) => agentPath(agent.slug)),
      ...saved.skills
        .filter((skill) => !skill.diagnostics.some(isError))
        .map((skill) => skillPath(skill.slug)),
    ]);
    const hasOwnError = (path: string) => {
      const agent = effective.agents.find((item) => agentPath(item.slug) === path);
      return (
        !agent || agent.diagnostics.some((d) => isError(d) && !d.code.startsWith("flow.subagent-"))
      );
    };
    for (const ownOnly of [true, false]) {
      const out = checkPackage(effective).leftOut.filter(
        (path) => usable.has(path) && !kept.includes(path) && (!ownOnly || hasOwnError(path)),
      );
      if (out.length === 0) continue;
      const files = { ...effective.files };
      for (const path of out) {
        const slug = skillSlugOf(path);
        const own =
          slug === undefined
            ? (name: string) => name === path
            : (name: string) => name.startsWith(`skills/${slug}/`);
        for (const name of Object.keys(files)) if (own(name)) delete files[name];
        for (const [name, text] of Object.entries(saved.files)) if (own(name)) files[name] = text;
      }
      const problems = Object.fromEntries(
        Object.entries(pkg.problems).filter(
          ([path]) => !kept.includes(path) && !out.includes(path),
        ),
      );
      effective = levels.compile({ coordinate: pkg.coordinate, files, problems });
      kept.push(...out);
    }
    return { effective, kept };
  }

  /** Each package's state, from the files `all` and the latest Saves. */
  async function statuses(all: PackageLevel[], saves: Saves): Promise<AgentPackageStatus[]> {
    const result: AgentPackageStatus[] = [];
    for (const level of WRITER_LEVELS) {
      const here = packagesOf(all.find((item) => item.level === level));
      const folders = new Set([...here.keys(), ...saves[level].map((save) => save.folder)]);
      for (const folder of [...folders].sort(byFolder)) {
        const pkg = here.get(folder);
        const save = saves[level].find((item) => item.folder === folder);
        const saved = save?.packageRevisionId ? save : undefined;
        const check = pkg ? checkPackage(pkg) : undefined;
        const state: AgentPackageStatus["state"] = !pkg
          ? saved
            ? "removed"
            : "saved"
          : check && check.blocking.length > 0
            ? "cant-save"
            : !saved
              ? "not-saved"
              : filesDigest(pkg) === saved.contentDigest
                ? "saved"
                : "unsaved";
        result.push({
          level,
          folder,
          state,
          savedAt: saved ? saved.createdAt.toISOString() : null,
          saveId: save?.id ?? null,
          undoneSaveIds: save?.undoneSaveIds ?? [],
          undoable:
            save?.hasPrevious && !save.undoneSaveId
              ? { saveId: save.id, at: save.createdAt.toISOString(), by: save.savedBy }
              : null,
          changes: changesOf(await savedFiles(saved), pkg?.files, level, folder),
          findings: (check?.findings ?? []).map(findingOf),
        });
      }
    }
    return result;
  }

  const saver: PackageSaver = {
    async savePackages(userId, { projectId, packages, by = "writer" }) {
      const [all, saves] = await Promise.all([
        levels.fromFiles(userId, projectId),
        levels.readSaves(userId, projectId),
      ]);
      const targets =
        packages === "all"
          ? WRITER_LEVELS.flatMap((level) => {
              const folders = new Set([
                ...packagesOf(all.find((item) => item.level === level)).keys(),
                ...saves[level].map((save) => save.folder),
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
        // The saved version a Save builds on is read, and the result published, under the package's
        // one ordering, so a concurrent Save is never put back by a decision made on an older read.
        const { value: outcome, row } = await store.settleSave<SaveOutcome | undefined>(
          owner,
          folder,
          async (latest) => {
            const saved = latest?.packageRevisionId ? latest : undefined;
            if (!pkg && !saved) return { value: undefined };
            const savedPackage = await savedPackageOf(saved);
            const check = pkg ? checkPackage(pkg) : undefined;
            const blocked = check !== undefined && check.blocking.length > 0;
            const { effective, kept } =
              pkg && !blocked
                ? keepLastGood(pkg, savedPackage)
                : { effective: pkg, kept: [] as string[] };
            const leftOut = effective && !blocked ? checkPackage(effective).leftOut : [];
            // An error on an item that now runs (one only a broken subagent held back) is no longer news.
            const shown = shownFindings(check?.findings ?? [])
              .filter(
                (item) =>
                  item.severity !== "error" ||
                  !agentSlugOrSkill(item.file) ||
                  kept.includes(item.file) ||
                  leftOut.includes(item.file),
              )
              .map(findingOf);
            const base = {
              level,
              folder,
              changes: changesOf(savedPackage?.files, effective?.files, level, folder),
              kept,
              leftOut,
              renamed: [] as string[],
              savedBefore: saved !== undefined,
            };
            if (blocked) {
              return {
                value: {
                  ...base,
                  outcome: "failed" as const,
                  findings: shown.filter((item) => item.severity === "error"),
                },
              };
            }
            if (effective && saved && filesDigest(effective) === saved.contentDigest) {
              return { value: { ...base, outcome: "unchanged" as const, findings: shown } };
            }
            const revision = effective ? await levels.install(effective) : undefined;
            return {
              value: { ...base, outcome: "saved" as const, findings: shown },
              publish: { packageRevisionId: revision?.packageRevisionId ?? null, savedBy: by },
            };
          },
        );
        if (!outcome) continue;
        if (!row) {
          outcomes.push(outcome);
          continue;
        }
        input.onSaved?.(userId, projectId, level);
        const undone = saves[level].find((item) => item.folder === folder)?.undoneSaveIds ?? [];
        saves[level] = [
          ...saves[level].filter((item) => item.folder !== folder),
          { ...row, undoneSaveIds: undone },
        ];
        const after = namesOf(await levels.fromSaves(saves));
        outcomes.push({
          ...outcome,
          outcome: "saved",
          saveId: row.id,
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
      const result =
        owner &&
        (await store.undoSave(owner, saveId, async (undone, target) => {
          const folder = undone.folder;
          const was = writtenFiles(await savedFiles(undone), level, folder);
          const to = writtenFiles(await savedFiles(target), level, folder);
          // Only a file both versions have, and that the Save changed: one the Save added, or
          // that the previous save lacked, stays, and so does one the writer deleted.
          const files = Object.fromEntries(
            Object.keys(was)
              .filter((path) => Object.hasOwn(to, path) && was[path] !== to[path])
              .map((path) => [`${folder}${path}`, { base: was[path], target: to[path] }]),
          );
          if (Object.keys(files).length > 0) {
            const prepared = await levelFiles.prepareFiles({
              level,
              userId,
              projectId,
              files,
              create: false,
              delete: false,
            });
            await prepared.applyFiles();
          }
        }));
      if (result?.undone) input.onSaved?.(userId, projectId, level);
      return {
        undone: Boolean(result?.undone),
        reason: result?.undone ? null : (result?.reason ?? "not-found"),
      };
    },
  };
  return { ...saver, statuses };
}
