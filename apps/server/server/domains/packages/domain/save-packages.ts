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
  savePackages(
    userId: string,
    input: {
      by?: "writer" | "ai";
      projectId?: string;
      packages: "all" | Array<{ level: AgentsLevel; folder: string }>;
    },
  ): Promise<SaveOutcome[]>;
  undoSave(
    userId: string,
    input: { projectId?: string; level: AgentsLevel; saveId: string },
  ): Promise<UndoSaveResponse>;
}

const WRITER_LEVELS = ["user", "project"] as const;

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

  async function statuses(all: PackageLevel[], saves: Saves): Promise<AgentPackageStatus[]> {
    const result: AgentPackageStatus[] = [];
    for (const level of WRITER_LEVELS) {
      const here = packagesOf(all.find((item) => item.level === level));
      const folders = new Set([...here.keys(), ...saves[level].map((save) => save.folder)]);
      for (const folder of [...folders].sort(byFolder)) {
        const pkg = here.get(folder);
        const save = saves[level].find((item) => item.folder === folder);
        const saved = save?.packageRevisionId ? save : undefined;
        const savedPackage = await savedPackageOf(saved);
        const check = pkg ? checkPackage(pkg) : undefined;
        const blocked = check !== undefined && check.blocking.length > 0;
        const effective = pkg && !blocked ? keepLastGood(pkg, savedPackage).effective : pkg;
        const state: AgentPackageStatus["state"] = !effective
          ? saved
            ? "removed"
            : "saved"
          : blocked
            ? "cant-save"
            : !saved
              ? "not-saved"
              : filesDigest(effective) === saved.contentDigest
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
          changes: changesOf(savedPackage?.files, effective?.files, level, folder),
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

      const namesOf = (all: PackageLevel[]) =>
        new Map(winners(agentsOf(all)).map((entry) => [entry.slug, entry.value !== null]));

      const outcomes: SaveOutcome[] = [];
      let before = namesOf(await levels.fromSaves(saves));
      for (const { level, folder } of targets) {
        const owner = levels.ownerOf(level, userId, projectId);
        if (!owner) continue;
        const pkg = packagesOf(all.find((item) => item.level === level)).get(folder);
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
